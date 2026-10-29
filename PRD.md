# Bocchi PRD

## Summary

Bocchi is a Manifest V3 privacy extension for Chromium that reduces browser fingerprint linkability and WebRTC leaks while keeping sites usable. Distribution target: GitHub Releases, not the Chrome Web Store.

The product is for people who want stronger fingerprint protection than a browser's default without adopting a hardened anonymity browser or hand-editing a list of technical switches.

## Problem

Browsers expose enough stable signals to identify a device across visits: canvas and WebGL rendering, audio output, installed fonts, GPU details, screen parameters, timezone, and WebRTC network paths. Blocking all of them breaks sites; doing nothing leaves a persistent profile.

Bocchi takes a middle path: reduce high-entropy signals with per-load randomization, keep low-entropy signals native, expose only the controls that matter, and let users bypass individual sites.

## Audience

- Privacy-conscious Chromium users who do not want a separate browser.
- VPN and proxy users whose browser timezone contradicts their exit IP.
- Developers and power users who want auditable, local behavior and per-site control.
- Chinese-speaking users: the interface copy is Chinese-first; technical documentation is English.

## Goals

1. Reduce cross-site and cross-session linkability on high-entropy browser surfaces.
2. Preserve ordinary browsing and let users bypass a broken site without disabling the extension globally.
3. Keep processing local, with disclosed network exceptions only for GeoIP timezone lookup and settings-panel city localization.
4. Make protection state visible and reversible through a compact popup and settings panel.
5. Keep the implementation dependency-free, auditable, and testable in a real Chromium build.

## Non-goals

- Anonymity or Tor-equivalent resistance.
- Ad blocking or a general content-blocking rule language.
- Firefox, Safari, or mobile browser support.
- Accounts, cloud sync, telemetry, or remote configuration.
- Chrome Web Store distribution for the current release.

## Product requirements

- One global shield plus independent module and per-surface controls.
- Canvas, WebGL, audio, font, Worker, hardware, and timing protections.
- WebRTC local-IP scrubbing and optional full blocking.
- Timezone alignment with automatic, manual, and location-based modes.
- Opt-in language and geolocation spoofing.
- Per-site exception list that removes content-script injection.
- JSON settings backup and restore.
- No page content, browsing history, or credentials sent off-device.

## Defaults

- Global shield, fingerprint modules, fonts, and timezone protection are on.
- Language and geolocation spoofing are off.
- WebRTC full-block options and non-proxied UDP blocking are off.
- GeoIP timezone lookup is on while timezone protection is on and is disclosed in the UI documentation and privacy policy.

## Success criteria

- Unit suite, timezone matrix, real-browser extension smoke, performance benchmark, and 30-minute soak pass.
- The packaged ZIP contains exactly the runtime allowlist and its version agrees across `manifest.json`, `package.json`, and `CHANGELOG.md`.
- A bypassed site receives no engine or bridge injection.
- No known high-severity security finding remains in the release scope.
- Settings survive extension updates and can be exported/imported.

## Constraints and risks

- Fingerprint randomization is detectable under advanced probing; the goal is unlinkability, not invisibility.
- SharedWorkers and some site Service Worker surfaces remain native because wrapping them would break platform behavior.
- The first inline script on a page can run before the asynchronous bridge configuration arrives.
- Public-suffix validation uses a curated list, not the complete Public Suffix List.
- GeoIP lookup sends the request IP to a third party; disabling timezone protection stops it.
- The declared minimum is Chromium 111, while current release testing uses Chrome for Testing 156.

## Release

Current line: `1.1.0`. Distribution target: a GitHub Release containing `bocchi-v1.1.0.zip`; no Chrome Web Store submission is planned for this release.
