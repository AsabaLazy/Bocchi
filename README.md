# Bocchi Privacy Shield

A Manifest V3 Chromium extension engineered for advanced browser fingerprint defense, WebRTC leak prevention, and cross-site tracker neutralization.

## Key Features

- **High-Entropy Vector Randomization**: Canvas 2D, WebGL, and audio fingerprints are randomized per session on every site. Values stay stable within a site for the session yet differ across sites and sessions, so trackers cannot correlate visits into a persistent cross-site profile. Low-entropy signals (user agent, platform, languages) are left native.
- **Font Minimization & Filtering**: Hides locale-revealing and non-standard fonts from canvas measurement and `@font-face` probes, exposing only a minimal set of universal fonts, with per-site allow/block lists.
- **Automatic Timezone Alignment**: Syncs the browser timezone (`Date`, `Intl.DateTimeFormat`) to match the network egress IP, eliminating timezone/IP discrepancies.
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
│   └── test_apivoid_tamper.js # CDP tamper-resistance test on APIVoid bot-detection page
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

Run the test suites with Node.js:

```bash
# Run unit tests
node tests/stealth.test.js

# Run live CreepJS audit (requires Chromium installed)
node tests/live_creep_verify.js

# Performance baseline: extension off vs on, same workload (deltas are the output)
CHROME_BIN=/path/to/chrome node tests/perf_bench.js both

# Leak soak: mixed workload churn, retained-heap sampling every minute
CHROME_BIN=/path/to/chrome node tests/soak_verify.js 30
```

The live verification scripts (`live_creep_verify.js`, `check_apivoid_live.js`, `diagnose_apivoid.js`, `test_apivoid_tamper.js`, `perf_bench.js`, `soak_verify.js`) drive a real browser over the Chrome DevTools Protocol and therefore require a local Chromium installation (override the binary via the `CHROME_BIN` environment variable). **Note:** branded Google Chrome 137+ silently ignores `--load-extension` — for live/bench scripts use Chromium or Chrome for Testing (`npx @puppeteer/browsers install chrome@stable --path /tmp/cft`). The unit test suite runs under plain Node.js with no browser required.
