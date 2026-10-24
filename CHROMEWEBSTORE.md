# Chrome Web Store Listing — Bocchi Privacy Shield

> Last Updated: 2026-10-23

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
- WebRTC IP Leak Prevention: Masks media-device lists and scrubs private IPs from WebRTC connection data. Optional non-proxied UDP blocking is available for proxy/VPN users who want the strongest setting.
- Timezone Consistency: Aligns the browser timezone to match your connection's exit point when timezone protection is enabled, preventing geographic location mismatches. GeoIP lookups are skipped while the feature or the global shield is off.
- Network Tracking Blocking: Stops known cross-site tracking domains and enforces Do-Not-Track and Global Privacy Control signals.
- Low-Breakage Defaults: Low-entropy signals stay native, and the settings that commonly break WebRTC calls, low-latency streams, controllers, or locale-sensitive sites are off by default. Every module can be bypassed per site.

How to Use:
1. Install Bocchi Privacy Shield.
2. The shield activates automatically in the background on all websites you visit.
3. Browse normally with continuous protection against passive device identification.

Privacy Commitment:
Bocchi Privacy Shield is privacy-focused. All fingerprinting protections and calculations run strictly inside your local browser. The extension does not collect, record, or transmit your browsing history, page content, or personal communications to developer servers. There are two disclosed network features: (1) when timezone protection and the global shield are enabled, exit-timezone lookups go to third-party GeoIP services (ipwho.is, get.geojs.io, ipapi.co); (2) when the settings panel localizes built-in city names, it may query the Wikipedia API for translations of a fixed city list. These providers necessarily receive the IP address as part of the request. The timezone, approximate coordinates, and city translations are cached locally; the raw IP is not stored, and GeoIP lookups are skipped when the feature is disabled.

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
| Screenshot 1 [REQUIRED] | 1280×800 | ✅ Created | `store-assets/screenshot-1.png` |
| Screenshot 2 [RECOMMENDED] | 1280×800 | ✅ Created | `store-assets/screenshot-2.png` |
| Small Promo Tile [RECOMMENDED] | 440×280 | ✅ Created | `store-assets/promo-small.png` |
| Marquee Promo Tile | 1400×560 | ✅ Created | `store-assets/promo-marquee.png` |

### Screenshot Notes
- Screenshot 1: Canvas & 3D fingerprint settings with per-surface sub-switches.
- Screenshot 2: WebRTC leak protection settings, including the explicit full-block options.

## Permissions Justification

| Permission | Type | Justification |
|------------|------|---------------|
| `alarms` | permissions | Periodically refreshes exit-node timezone mapping so privacy shields adapt automatically when connecting to different VPN endpoints without restarting Chrome. |
| `declarativeNetRequest` | permissions | Applies DNT/GPC privacy signals and blocks known tracking domains at the network layer without inspecting user page contents. |
| `fontSettings` | permissions | Enumerates the user's installed system fonts to apply the user's font-privacy preferences (identifying and masking locale-revealing fonts). All processing stays on-device. |
| `privacy` | permissions | Applies the selected WebRTC IP handling policy. Local-IP cleaning is on by default; non-proxied UDP blocking is opt-in for proxy/VPN users. |
| `storage` | permissions | Stores local privacy preferences and caches the exit-node timezone mapping on the user's device. The hourly alarm forcibly refreshes this mapping on schedule; the 4-hour cache only reduces lookups between page navigations rather than preventing the recurring network requests. |
| `<all_urls>` | host_permissions | Applies anti-fingerprinting shields (randomized canvas, audio, and font characteristics) across all websites the user visits to stop cross-site profile tracking. The same permission supports content-script injection, optional GeoIP exit-timezone lookups, and Wikipedia city-name translations in the settings panel. |

## Privacy & Data Use

**Does the extension collect user data?** Yes (limited) — IP-derived approximate location only; see the Data Use table below.

| Data Type | Collected? | Transmitted Off-Device? | Purpose | Shared with Third Parties? |
|-----------|-----------|------------------------|---------|---------------------------|
| Personally identifiable info | No | No | None | No |
| Health info | No | No | None | No |
| Financial info | No | No | None | No |
| Authentication info | No | No | None | No |
| Personal communications | No | No | None | No |
| Location | Yes (IP-derived approximate location) | Yes, only when timezone protection and the global shield are enabled | Exit-timezone lookup via third-party GeoIP services (ipwho.is, get.geojs.io, ipapi.co). The timezone and approximate coordinates are cached locally; the raw IP is not stored. Lookups are skipped when the feature is off. | Yes (GeoIP providers necessarily receive the IP address as part of each lookup) |
| Web history | No | No | None | No |
| User activity | No | No | None | No |
| Website content | No | No | None | No |

### Data Use Certification
- [x] Data is NOT sold to third parties
- [x] Data is NOT used for purposes unrelated to the extension's core functionality
- [x] Data is NOT used for creditworthiness or lending purposes

## Privacy Policy

**Privacy Policy URL** [REQUIRED]
https://github.com/AsabaLazy/Bocchi/blob/main/PRIVACY.md

*(Self-hosted or hosted on repository site before submission)*

## Distribution

**Visibility**: Public
**Regions**: All regions

## Developer Info

**Publisher Name** [REQUIRED]
Bocchi Privacy Team

**Contact Email** [REQUIRED]
CakeAlter@proton.me

**Support URL / Email** [RECOMMENDED]
https://github.com/AsabaLazy/Bocchi/issues

## Version History

| Version | Date | Changes | Status |
|---------|------|---------|--------|
| 1.1.0 | 2026-10-23 | Settings UX and terminology refresh, WebRTC full-block options, click-to-open per-module help, compatibility-focused defaults, site-bypass manager, GeoIP lookup gating, store assets, and a release-hardening pass (Date/canvas/WebRTC correctness, DNR/bypass safety, real-browser smoke CI). | Release candidate |
| 1.0.1 | 2026-10-18 | Entropy-reduction rework — per-page-load farbling on all sites, GPU profile pool, cross-realm toString consistency, timezone passthrough, privacy disclosure updates. | Draft |
| 1.0.0 | 2026-09-30 | Initial Manifest V3 release with Canvas/WebGL/Audio protections, WebRTC IP masking, timezone synchronization, and TraceScope anti-leak mitigations. | Draft |

## Review Notes

### Known Issues / Limitations
- Existing installations keep their saved settings after upgrade. Click “恢复默认” to adopt the new compatibility defaults.
- The MAIN-world engine starts at `document_start`, while its configuration arrives through the isolated-world bridge one task later. Global off now removes the content scripts entirely; for individual module switches, the first inline script on a page can briefly observe the fail-closed defaults before the config handshake completes. Reload the page after changing a module switch if a site's earliest inline code misbehaves.
- Font filtering and fingerprint randomization still leave a theoretical detection window under extreme probing (e.g., exhaustive glyph-metric differential testing).
- The dedicated Web Worker wrapper (blob URL instrumentation) can affect the small number of libraries that rely on locating their own script via its blob URL. Only dedicated Workers are wrapped; SharedWorker construction is left fully native because blob-URL wrapping mints a unique URL per construction and would silently break cross-tab worker sharing semantics.
- Per-session fingerprint randomization prioritizes unlinkability over uniformity: dedicated tooling may notice that fingerprint values change between sessions, even though it cannot link them across sites.

Fully compatible with Chrome Manifest V3 specifications. Tested against EFF Cover Your Tracks and BrowserLeaks test suites.
