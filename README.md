# Bocchi Privacy Shield

A Manifest V3 Chromium extension engineered for advanced browser fingerprint defense, WebRTC leak prevention, and cross-site tracker neutralization.

## Key Features

- **High-Entropy Vector Randomization**: Canvas 2D, WebGL, and audio fingerprints are randomized per page load on every site. A fresh farbling salt is drawn on each page load; values stay stable within a single page load yet differ across sites and across reloads (refreshing rotates them), so trackers cannot correlate visits into a persistent cross-site profile. Low-entropy signals (user agent, platform, languages) are left native.
- **Font Filtering & Masking (Two Modes)**: Hides fonts from canvas measurement, `@font-face`, and local font enumeration (`queryLocalFonts`) probes. Default **blacklist mode** hides built-in Chinese/CJK fonts (toggleable) plus user-defined custom entries, and can hide other non-Latin script fonts or symbol/dingbat fonts by filtering the list by type and applying a batch hide — everything else stays visible. Optional **whitelist mode** restricts enumeration to a user-curated allow list. Font allow/block lists are global; per-site control is via the shield bypass list.
- **Automatic Timezone Alignment**: Syncs the browser timezone (`Date`, `Intl.DateTimeFormat`) to match the network egress IP, eliminating timezone/IP discrepancies; a manual override is available via an IANA selector or an offline world-map picker, optionally linked with the spoofed geolocation.
- **Geolocation Spoofing (opt-in)**: Reports user-chosen coordinates (manual latitude/longitude or an offline world-map picker) through `navigator.geolocation`; disabled by default.
- **WebRTC Leak Prevention**:
  - Enforces `disable_non_proxied_udp` policy via `chrome.privacy.network.webRTCIPHandlingPolicy`.
  - Sanitizes local/host IP candidates in SDP offers/answers (`RTCPeerConnection.prototype.createOffer`, `setLocalDescription`, `localDescription`).
- **Network Privacy**:
  - DeclarativeNetRequest rules block intrusive tracking domains (`trackersimulator.org`, `eviltracker.net`, etc.).
  - Enforces `DNT: 1` and `Sec-GPC: 1` privacy signal headers.
- **LibreWolf-Style Reductions**: Clamps timer precision, degrades the Gamepad API and high-resolution device enumeration (media devices). `hardwareConcurrency`/`deviceMemory` stay native on purpose: their fixed-value degradation cannot be kept consistent across realms (SharedWorker script URLs cannot be safely wrapped), and consistency beats a marginal entropy reduction on these low-signal vectors.
- **Worker Cross-Context Protection**: Injects cross-context protections into dedicated Web Workers (classic and module, via blob URL instrumentation). SharedWorkers are intentionally left unwrapped: blob-wrapping a SharedWorker breaks cross-tab worker sharing (a documented Vite/Parcel regression class), and the resulting inconsistency would be worse than the exposed values.
- **Secure Cross-World Config Sync**: ISOLATED↔MAIN world configuration synchronization uses a secured channel with a one-time token handshake (randomized event names + token validation), so page scripts cannot forge or eavesdrop on shield configuration.

## Directory Structure

```text
├── manifest.json              # Extension Manifest V3 configuration
├── background/
│   └── service_worker.js      # Background service worker (WebRTC policy, GeoIP timezone sync, periodic alarms)
├── content/
│   ├── bridge.js              # ISOLATED world bridge for timezone synchronization
│   └── stealth_engine.js      # MAIN world script executing all prototype protections
├── icons/
│   ├── icon-16.png            # 16×16 toolbar icon
│   ├── icon-48.png            # 48×48 extension management icon
│   └── icon-128.png           # 128×128 Chrome Web Store icon
├── popup/
│   ├── popup.css              # Toolbar popup styles
│   ├── popup.html             # Toolbar popup markup (shield status & quick toggles)
│   └── popup.js               # Toolbar popup logic (global & per-site shield toggles)
├── panel/
│   ├── panel.css              # Font privacy panel styles
│   ├── panel.html             # Font privacy panel markup
│   └── panel.js               # Font privacy panel logic (font enumeration & masking preferences)
├── rules/
│   └── cyt_rules.json         # DeclarativeNetRequest network rules
├── tests/
│   ├── stealth.test.js        # Core unit & integration test suite
│   ├── live_creep_verify.js   # CDP automated live verification against CreepJS
│   ├── check_apivoid_live.js  # CDP live check against APIVoid bot-detection test page
│   ├── diagnose_apivoid.js    # CDP diagnostics for APIVoid detection results
│   ├── test_apivoid_tamper.js # CDP tamper-resistance test on APIVoid bot-detection page
│   ├── perf_bench.js          # CDP performance baseline: extension off vs on (deltas)
│   └── soak_verify.js         # CDP leak soak: mixed workload + retained-heap sampling
├── CHROMEWEBSTORE.md          # Chrome Web Store listing, permissions & review notes
└── package-extension.sh       # Extension zip packager
```

## Installation & Development

1. Open Chromium or Google Chrome and navigate to `chrome://extensions/`.
2. Enable **Developer mode** in the top right corner.
3. Click **Load unpacked** and select this directory (`/path/to/Bocchi`).

## Packaging

To produce a production zip archive ready for distribution:

```bash
./package-extension.sh
```

This generates `bocchi-privacy-shield-v1.0.0.zip`.

## Testing

Run the test suites with Node.js (all live scripts need a local Chromium, override the binary via `CHROME_BIN`):

```bash
npm test              # unit suite (no browser, ~0.2s)
npm run test:tz       # unit suite × 5 timezones (portability matrix)
npm run test:live     # live regression chain, sequential (creep gate → apivoid → tamper)
npm run test:headed   # same chain in visible desktop windows (deployment-realistic)
npm run bench         # engine-hook performance benchmark (~6s, report in tests/reports/)
npm run soak          # long-run leak soak, default 30 minutes (npm run soak -- 5 to shorten)
```

Every live script runs on the shared harness (`tests/lib/live_harness.js`): it
discovers the browser, allocates a free port, retries transient launch
failures, verifies the engine actually applied before probing (a bare
browser cannot masquerade as a result), cleans up its temp profile and drops
a timestamped JSON report under `tests/reports/`. `live_creep_verify.js` is a
gated regression test (13 checks, exits 1 on failure); the apivoid scripts
are diagnostics (no gate) — note APIVoid rate-limits rapid POSTs and its
verdict can flip between runs where only the extension's per-session
randomized canvas/webgl/audio hashes differ.

The live verification scripts (`live_creep_verify.js`, `check_apivoid_live.js`, `diagnose_apivoid.js`, `test_apivoid_tamper.js`, `perf_bench.js`, `soak_verify.js`) drive a real browser over the Chrome DevTools Protocol and therefore require a local Chromium installation (override the binary via the `CHROME_BIN` environment variable). **Note:** branded Google Chrome 137+ silently ignores `--load-extension` — for live/bench scripts use Chromium or Chrome for Testing (`npx @puppeteer/browsers install chrome@stable --path /tmp/cft`). The unit test suite runs under plain Node.js with no browser required.
