# Bocchi Privacy Shield

A Manifest V3 Chromium extension engineered for advanced browser fingerprint defense, WebRTC leak prevention, and cross-site tracker neutralization.

## Key Features

- **Anti-Fingerprinting Defense**:
  - **Canvas 2D & WebGL**: Sub-pixel normalization and seed-based farbling that defeats canvas/WebGL fingerprinting while preserving visual fidelity.
  - **AudioBuffer Alignment**: Calibrated WebAudio dynamics compressor reduction and channel data summation to match standard Blink expectations (passing CreepJS with 0 lies and 0 bold fails).
  - **Font Masking**: Hides non-standard and localized Chinese/host fonts from canvas measurement and `@font-face` probes, exposing only universal standard system fonts.
  - **Dynamic Timezone & Locale Alignment**: Auto-syncs browser timezone (`Date`, `Intl.DateTimeFormat`) and locale (`Intl.NumberFormat`, `PluralRules`, `RelativeTimeFormat`, `Collator`) to match the network egress IP, eliminating timezone/IP discrepancies.
  - **Worker & SharedWorker Isolation**: Injects cross-context spoofing into dedicated Web Workers and SharedWorkers via blob URL instrumentation.
- **WebRTC Leak Prevention**:
  - Enforces `disable_non_proxied_udp` policy via `chrome.privacy.network.webRTCIPHandlingPolicy`.
  - Sanitizes local/host IP candidates in SDP offers/answers (`RTCPeerConnection.prototype.createOffer`, `setLocalDescription`, `localDescription`).
- **Network Privacy**:
  - DeclarativeNetRequest rules to block intrusive tracking domains (`trackersimulator.org`, `eviltracker.net`, etc.).
  - Enforces `DNT: 1`, `Sec-GPC: 1`, and `Accept-Language: en-US,en;q=0.9` network headers.

## Directory Structure

```text
├── manifest.json              # Extension Manifest V3 configuration
├── background/
│   └── service_worker.js     # Background worker (IP timezone detection & WebRTC policy)
├── content/
│   ├── bridge.js             # ISOLATED world bridge for timezone synchronization
│   └── stealth_engine.js     # MAIN world script executing all prototype protections
├── rules/
│   └── cyt_rules.json        # DeclarativeNetRequest network rules
├── tests/
│   ├── stealth.test.js       # Core unit & integration test suite
│   └── live_creep_verify.js  # CDP automated live verification against CreepJS
└── package-extension.sh      # Extension zip packager
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
```
