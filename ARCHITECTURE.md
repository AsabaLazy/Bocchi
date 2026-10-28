# Architecture

## Stack

- Chrome Manifest V3, Chromium 111+.
- Vanilla HTML, CSS, and JavaScript. No framework, bundler, or runtime dependencies.
- `chrome.storage.local` for settings and caches.
- `chrome.scripting` for dynamic content-script registration.
- `chrome.declarativeNetRequest` for static tracking rules and the dynamic Accept-Language rule.
- `chrome.privacy` for WebRTC IP handling.
- Node.js 22+ and Chrome for Testing 156 for tests and packaging.

## Repository map

```text
manifest.json                 Extension manifest
background/service_worker.js  Registration, DNR, WebRTC policy, GeoIP cache, alarms
content/bridge.js             ISOLATED-world config bridge
content/stealth_engine.js     MAIN-world fingerprint protections
popup/                        Toolbar popup
panel/                        Full settings surface
rules/cyt_rules.json          Static DNR rules
icons/                        Extension icons
tools/                        Font-language coverage generator
tests/                        Unit, real-browser, performance, and soak tests
docs/                         FAQ and design-reference images
package-extension.sh          Allowlisted distribution ZIP
```

`ARCHITECTURE.md`, `PRD.md`, `DESIGN.md`, and `RULES.md` live at the repository root. Screenshots and promotional assets are not part of the extension ZIP.

## Runtime components

**Service worker.** Owns state that must survive page navigation: content-script registration, the DNR ruleset, WebRTC policy, GeoIP lookup and cache, and alarms. It is event-driven and may be suspended between events.

**Bridge.** Runs in the ISOLATED world at `document_start`. Reads stored settings and sends one authenticated configuration payload per frame.

**Engine.** Runs in the MAIN world at `document_start`. Installs the per-page fingerprint protections and accepts configuration only through the bridge handshake.

**Panel and popup.** Write settings to `chrome.storage.local`, which the service worker and bridge observe. The panel also manages fonts, per-site exceptions, and JSON backup/restore.

## Data flow

```text
panel / popup
     │ chrome.storage.local.set / get
     ▼
service worker ──────► chrome.scripting.registerContentScripts
     │                 (engine MAIN + bridge ISOLATED, document_start)
     │                 excludes siteBypassList
     ▼
engine (MAIN) ───────► bridge (ISOLATED)
   __bocchi_hs__ {token, event}
                         │ ack + config payload
                         ▼
                       engine (MAIN)
                         │ tz / fonts / cfg / geo
                         ▼
                       page APIs
```

1. On install, startup, and storage changes, the service worker reconciles the registered content scripts with `globalShieldEnabled` and `siteBypassList`.
2. The engine announces a per-bootstrap token and a random config event name. The bridge waits for that handshake, acknowledges it, and reads the current settings.
3. The bridge sends an authenticated config payload; the engine validates the token and applies timezone, font, canvas, audio, WebRTC, hardware, and language configuration.
4. Per-page random salts are derived locally. The same page load is stable; separate loads and sites diverge.
5. The service worker applies DNR rules, WebRTC policy, and GeoIP timezone refresh independently of page injection.
6. A bypassed site receives no engine or bridge script. Global network policy remains active.

## Stored state

Grouped by purpose:

- Shield and modules: `globalShieldEnabled`, per-module switches, per-surface switches.
- Fonts: `fontMode`, hidden and allowed font lists, language coverage preferences.
- Language: target locale and three sub-switches.
- Time: `timezoneMode`, manual/geo/target zones, coordinates, GeoIP cache.
- Privacy: `siteBypassList`, theme, version.
- UI/backup: font-language cache and city-name translation cache.

No storage key contains page content, browsing history, or credentials. The raw IP address is not stored.

## Security boundaries

- Page scripts run in the MAIN world; extension APIs exist only in the ISOLATED/service-worker contexts.
- The MAIN↔ISOLATED channel uses a per-frame random event name and a one-time token. This prevents casual forgery; it is not cryptographic isolation from a page that can inspect the engine source.
- Content-script registration fails closed: if the extension cannot confirm state, it keeps existing registrations rather than exposing an unprotected page.
- The extension ships no remote code and uses no `eval`, CDN scripts, or remote modules.
- Network requests are limited to the disclosed GeoIP providers and settings-panel city localization. They never include page content or browsing history.
- The package is built from an explicit allowlist; tests and docs cannot leak into the runtime ZIP.

## Build and verification

`package-extension.sh` writes `bocchi-v<version>.zip` and verifies the exact file set against `manifest.json`, `package.json`, and `CHANGELOG.md`.

The test stack is:

- `tests/stealth.test.js`: VM-based unit and integration assertions.
- `tests/extension_smoke.js`: real Chromium registration, injection, protocol, canvas, Date, font, and WebRTC smoke.
- `tests/live_creep_verify.js`: gated CreepJS audit.
- `tests/perf_bench.js`: hook overhead and memory baseline.
- `tests/soak_verify.js`: 30-minute retained-memory and listener soak.
- `.github/workflows/ci.yml`: unit, timezone, package, and extension smoke jobs.

## Known constraints

- Fingerprint randomization is detectable by advanced probing; it reduces linkability, not detectability.
- SharedWorkers are left native because wrapping them breaks cross-tab sharing.
- The public-suffix check uses a curated set, not the full Public Suffix List.
- The first inline script on a page can run before the asynchronous config handshake completes.
- GeoIP timezone protection is enabled by default and performs a disclosed third-party request; disabling it stops the request.
