# Engineering Rules

These rules apply to every change in this repository. If a request conflicts with a privacy or security boundary, stop and ask.

## Priorities

1. User safety and privacy.
2. Correct behavior on real Chromium.
3. Existing product contracts and compatibility defaults.
4. Minimal, local changes.
5. Visual polish.

Do not trade a higher-priority item for a lower one.

## Code style

- Plain HTML, CSS, and JavaScript. Do not add a framework, bundler, TypeScript, or runtime dependency without explicit approval.
- Follow the existing 2-space JavaScript style, semicolons, single quotes, and short focused functions.
- Use Chrome extension APIs directly. Do not wrap them in a second abstraction layer unless the repository already has one.
- Keep `content/bridge.js` in the ISOLATED world and `content/stealth_engine.js` in the MAIN world. Do not merge their responsibilities.
- Keep the service worker event-driven and idempotent. Registration, DNR, and policy reconciliation must be safe to run repeatedly.
- Keep comments for invariants and non-obvious trade-offs. Do not narrate obvious code.
- Preserve existing storage keys. A key rename requires a migration and a changelog entry.
- Keep the engine's `document_start` behavior. A later injection changes the threat model.

## Privacy rules

- Never add analytics, telemetry, advertising, tracking pixels, crash uploads, or remote configuration.
- Never collect or transmit page content, browsing history, form data, credentials, font lists, canvas values, audio values, or WebRTC details.
- The only allowed off-device requests are the disclosed GeoIP lookups while timezone protection is on, and fixed city-name localization from the settings panel. Any new endpoint needs explicit approval, a privacy-policy update, and a UI disclosure.
- Do not store raw IP addresses.
- Keep processing local by default. A feature that becomes network-dependent needs a separate design decision.

## Security rules

- Never introduce remote code: no CDN scripts, remote modules, `eval`, `new Function`, or remote `importScripts`.
- Never insert remote or user-controlled strings with `innerHTML`. Use `textContent` or the existing `escapeHtml` helper.
- Do not weaken the MAIN↔ISOLATED token handshake or make configuration page-forgeable.
- Do not make registration, storage reads, or bypass handling fail open. If the extension cannot confirm state, keep the last safe state.
- Do not broaden host permissions or add a permission without a concrete feature, a store-independent justification, and an update to `PRIVACY.md`.
- Validate imported JSON and every external value at the boundary. Do not trust storage, page messages, or fetched JSON.
- Do not log secrets, tokens, cookies, page data, or user identifiers.
- Keep `package-extension.sh` as an explicit allowlist. Never ship tests, docs, screenshots, or local caches.

## UI rules

- Follow `DESIGN.md`. Use its tokens and primitives; do not invent colors, font sizes, radii, or component styles.
- Keep the interface monochrome. Do not add gradients, colored accents, decorative icon tiles, or nested cards.
- Do not add secondary labels or description paragraphs when the title, rows, and controls already explain the interface.
- Do not add explanatory copy under every switch. Put technical details in the help popover.
- Do not add a second active indicator to navigation. Background or rule, not both.
- Use wrapping, not horizontal scrolling, for navigation at narrow widths.
- Every interactive control needs a visible focus state and an accessible name. Icon-only buttons require `aria-label`.
- Respect `prefers-reduced-motion`; animation must not block input.

## Testing rules

- Add or update assertions for every behavior change. Do not weaken an assertion just to make a suite pass.
- Run at least `npm test` after JavaScript changes. Run `npm run test:tz` after Date, timezone, Intl, or locale changes.
- Run `npm run test:extension` after manifest, registration, content-script, or browser behavior changes.
- Run `npm run bench` after engine hot-path changes. Run `npm run soak` before a release.
- Run `npm run package` after any runtime file change and verify the allowlist and version agreement.
- A green test is evidence only when it exercises the changed path. Do not claim a browser behavior was verified from a unit test alone.

## Release rules

- Keep `manifest.json`, `package.json`, `CHANGELOG.md`, and the output ZIP version aligned.
- Update the changelog for user-visible behavior, privacy changes, and compatibility changes.
- Distribute through GitHub Releases. Do not submit to the Chrome Web Store without explicit approval.
- Do not upload an old ZIP. The current artifact is `bocchi-v<version>.zip`.
- Update `PRD.md`, `ARCHITECTURE.md`, `DESIGN.md`, or `RULES.md` when the change alters their contract.

## AI must never

- Add telemetry or a new network request to make a feature easier to build.
- Add remote code or weaken the extension CSP.
- Disable, skip, or hollow out a test; invent a passing result; or claim a test ran when it did not.
- Remove a security check, bypass validation, or turn a fail-closed path into a fail-open path.
- Widen permissions or `<all_urls>` without an explicit requirement.
- Change the product name, description, privacy claims, or store copy without syncing every referenced file.
- Add secondary UI labels or descriptions that the layout already communicates.
- Commit or push without an explicit user request.
- Use `git commit`, `git add`, `git reset`, or `git push` in this colocated jj workspace.
- Commit secrets, personal identifiers, local paths, generated reports, or large binary assets.

## VCS

Use Jujutsu (`jj`) for status, diff, commit, bookmark, and push. Keep the working copy empty after a commit. Stage only files intentionally changed for the task and do not touch unrelated user changes.
