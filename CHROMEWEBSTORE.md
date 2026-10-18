# Chrome Web Store Listing — Bocchi Privacy Shield

> Last Updated: 2026-10-17

## Store Listing

**Extension Name** [REQUIRED]
Bocchi Privacy Shield

**Short Description** [REQUIRED]
Protect your privacy by blocking browser fingerprinting, preventing WebRTC IP leaks, and neutralizing cross-site tracking.

**Detailed Description** [REQUIRED]
Bocchi Privacy Shield protects your online identity by neutralizing advanced browser fingerprinting and cross-site tracking techniques without breaking websites.

Most websites track users not just through cookies, but through subtle device characteristics like screen rendering, audio hardware, installed fonts, and network leaks. Bocchi Privacy Shield prevents tracking networks from building a persistent profile of your device.

Key Features:
- Anti-Fingerprinting Protection: Randomizes high-entropy device characteristics (canvas, audio, and font signals) per session so trackers cannot link your visits across websites.
- WebRTC IP Leak Prevention: Blocks internal and local network IP leakage through peer-to-peer WebRTC connections.
- Timezone Consistency: Aligns the browser timezone to match your connection's exit point, preventing geographic location mismatches.
- Network Tracking Blocking: Stops known cross-site tracking domains and enforces Do-Not-Track and Global Privacy Control signals.
- Low-Breakage Design: Unlike aggressive blockers that break web pages, Bocchi Privacy Shield leaves low-entropy signals native and relies on per-session randomization, keeping websites fully functional.

How to Use:
1. Install Bocchi Privacy Shield.
2. The shield activates automatically in the background on all websites you visit.
3. Browse normally with continuous protection against passive device identification.

Privacy Commitment:
Bocchi Privacy Shield is completely privacy-focused. All fingerprinting protections and calculations run strictly inside your local browser. The extension does not collect, record, track, or transmit your personal data, browsing history, or website content to any developer servers.

**Category** [REQUIRED]
Productivity

**Single Purpose** [REQUIRED]
Protects user browsing privacy by preventing device fingerprinting, WebRTC IP leakage, and cross-site tracking.

**Primary Language** [REQUIRED]
English

## Graphics & Assets

| Asset | Dimensions | Status | Filename |
|-------|-----------|--------|----------|
| Store Icon [REQUIRED] | 128×128 PNG | ✅ Created | `icons/icon-128.png` |
| Screenshot 1 [REQUIRED] | 1280×800 or 640×400 | ⬜ Not created | `promo/screenshot-1.png` |
| Screenshot 2 [RECOMMENDED] | 1280×800 or 640×400 | ⬜ Not created | `promo/screenshot-2.png` |
| Small Promo Tile [RECOMMENDED] | 440×280 | ⬜ Not created | `promo/promo-small.png` |
| Marquee Promo Tile | 1400×560 | ⬜ Not created | `promo/promo-marquee.png` |

### Screenshot Notes
- Screenshot 1: Cover Your Tracks test result demonstrating "Randomized Fingerprint" and green privacy shields.
- Screenshot 2: BrowserLeaks test result demonstrating safe WebRTC IP handling and randomized fingerprints.

## Permissions Justification

| Permission | Type | Justification |
|------------|------|---------------|
| `alarms` | permissions | Periodically refreshes exit-node timezone mapping so privacy shields adapt automatically when connecting to different VPN endpoints without restarting Chrome. |
| `declarativeNetRequest` | permissions | Applies DNT/GPC privacy signals and blocks known tracking domains at the network layer without inspecting user page contents. |
| `fontSettings` | permissions | Enumerates the user's installed system fonts to apply the user's font-privacy preferences (identifying and masking locale-revealing fonts). All processing stays on-device. |
| `privacy` | permissions | Configures the browser WebRTC IP handling policy to `disable_non_proxied_udp`, preventing internal and private LAN IP addresses from leaking. |
| `storage` | permissions | Stores local privacy preferences and caches exit-node timezone mapping on the user's device to prevent repeated network requests. |
| `<all_urls>` | host_permissions | Applies anti-fingerprinting shields (randomized canvas, audio, and font characteristics) across all websites the user visits to stop cross-site profile tracking. |

## Privacy & Data Use

**Does the extension collect user data?** No

| Data Type | Collected? | Transmitted Off-Device? | Purpose | Shared with Third Parties? |
|-----------|-----------|------------------------|---------|---------------------------|
| Personally identifiable info | No | No | None | No |
| Health info | No | No | None | No |
| Financial info | No | No | None | No |
| Authentication info | No | No | None | No |
| Personal communications | No | No | None | No |
| Location | No | No | Non-identifying timezone query | No |
| Web history | No | No | None | No |
| User activity | No | No | None | No |
| Website content | No | No | None | No |

### Data Use Certification
- [x] Data is NOT sold to third parties
- [x] Data is NOT used for purposes unrelated to the extension's core functionality
- [x] Data is NOT used for creditworthiness or lending purposes

## Privacy Policy

**Privacy Policy URL** [REQUIRED]
**TODO:** Placeholder — replace with the real, publicly reachable privacy policy URL before store submission. Current placeholder value: `https://github.com/luo/bocchi/blob/main/PRIVACY.md`

*(Self-hosted or hosted on repository site before submission)*

## Distribution

**Visibility**: Public
**Regions**: All regions

## Developer Info

**Publisher Name** [REQUIRED]
Bocchi Privacy Team

**Contact Email** [REQUIRED]
**TODO:** Placeholder — replace with the real developer contact email before store submission. Current placeholder value: `privacy@example.com`

**Support URL / Email** [RECOMMENDED]
**TODO:** Placeholder — replace with the real support page or email before store submission. Current placeholder value: `https://github.com/luo/bocchi/issues`

## Version History

| Version | Date | Changes | Status |
|---------|------|---------|--------|
| 1.0.0 | 2026-09-30 | Initial Manifest V3 release with Canvas/WebGL/Audio protections, WebRTC IP masking, timezone synchronization, and TraceScope anti-leak mitigations. | Draft |

## Review Notes

### Known Issues / Limitations
- Font filtering and fingerprint randomization still leave a theoretical detection window under extreme probing (e.g., exhaustive glyph-metric differential testing).
- The Web Worker / SharedWorker wrapper (blob URL instrumentation) can affect the small number of libraries that rely on locating their own script via its blob URL.
- Per-session fingerprint randomization prioritizes unlinkability over uniformity: dedicated tooling may notice that fingerprint values change between sessions, even though it cannot link them across sites.

Fully compatible with Chrome Manifest V3 specifications. Tested against EFF Cover Your Tracks and BrowserLeaks test suites.
