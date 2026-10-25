# Changelog

## 1.1.0 — 2026-10-23

### Added

- Per-module click-to-open help with a concrete note for every sub-option.
- WebRTC full-block options: support-detection hiding, media-device blocking,
  and additional-object hiding.
- Site-bypass manager in the settings panel (add, validate, and remove domains).
- Privacy policy, Chrome Web Store screenshots, and promo tiles.
- CI workflow for the unit, timezone, packaging and real-browser extension smoke suites.

### Changed

- Renamed the product from Bocchi Privacy Shield to Bocchi across the manifest,
  interface, documentation, and distribution archive.
- Reordered the settings navigation so Canvas & WebGL is first and Fonts is not
  the default/first item.
- Standardized setting names around fingerprinting terminology: fingerprint
  protection, canvas readout/export, WebRTC leaks, and timezone/location
  spoofing. Refreshed the store screenshots to match.
- Cleaned up the settings surface: removed redundant nav dots and active-state
  bars, moved backup/restore to its own view, wrapped the narrow-screen nav,
  deferred off-screen font rows, and added a skip link.
- Kept timezone protection enabled by default and documented the default-on
  GeoIP lookup behavior explicitly, including how to stop it.
- Compatibility defaults: non-proxied UDP blocking and gamepad fingerprint
  hiding are now off for fresh installs and after “恢复默认”.
- Flattened decorative highlights: switch/knob shadows, raised selected states,
  map pin glow, and the ocean gradient.
- Help descriptions use the amber “说明” note style.

### Fixed

- GeoIP timezone lookups are skipped entirely when the global shield or timezone
  protection is disabled.
- Refresh the content-script registration and bypass list when sites are added
  or removed from the bypass manager.
- Date string construction/`Date.parse` now agrees with numeric construction in
  the spoofed timezone; native descriptors for `Date`/WebRTC are preserved.
- `toBlob`/`convertToBlob` encode an off-screen snapshot so asynchronous
  exports cannot overwrite later canvas drawing.
- WebRTC SDP sanitization still works while support-detection hiding is active.
- GeoIP failures no longer overwrite a valid cache; per-provider timeouts,
  failure backoff and forced panel refresh are handled explicitly.
- Font settings cannot be overwritten by the initial async panel load, and
  whitelist matching is exact (`Arial` no longer implicitly allows
  `Arial Black`).
- DNR bypass exclusions are validated/serialized, the static ruleset follows
  the global shield, and invalid/IP entries cannot disable the language rule.
- Worker-safe `Intl`/Date handling, Worker OffscreenCanvas 2D/pixel/font
  coverage, dynamic config propagation to already-created Workers, and
  DST/explicit-year Date parsing fixes.
- Empty `tz` is now an explicit reset instead of leaving a stale manual zone.
- Public suffixes such as `com` and `co.uk` are rejected as site exceptions;
  partial content-script unregister/list failures no longer fail open.
- GeoIP coordinate fallback no longer stops at the first timezone-only
  provider; forced refreshes can still fill the map location.
- Tests now gate assertion counts/success markers, soak/perf failures, exact
  zip contents and version agreement; a real-browser extension smoke test is
  included in CI and runs on Node 22 with pinned Chrome for Testing.

## 1.0.1 — 2026-10-18

- Entropy-reduction rework: per-page-load farbling on all sites, GPU profile
  pool, cross-realm toString consistency, timezone passthrough, and privacy
  disclosure updates.

## 1.0.0 — 2026-09-30

- Initial Manifest V3 release with Canvas/WebGL/Audio protections, WebRTC IP
  masking, timezone synchronization, and tracker blocking.
