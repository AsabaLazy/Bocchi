# Bocchi Privacy Shield — Privacy Policy

Last updated: 2026-10-23

Bocchi Privacy Shield is a Manifest V3 browser extension that reduces browser
fingerprinting and WebRTC leaks. This policy explains what the extension stores,
what it sends off-device, and what it never collects.

## Summary

- No account, analytics, telemetry, advertising, or tracking SDKs.
- Browsing history, page content, form data, and personal communications are not
  collected or transmitted.
- Settings and small caches are stored locally in the browser.
- Off-device requests are limited to optional GeoIP lookups used to align the
  timezone and city-name localization lookups made from the settings panel.
  Those providers receive the user's IP address as part of the request.
- No data is sold or shared with third parties for advertising or profiling.

## Data stored locally

The extension uses `chrome.storage.local` for:

- Module and sub-option settings, theme, and default mode.
- The user's site-bypass list.
- Font selections and font-language coverage preferences.
- Timezone and geolocation preferences.
- Cached GeoIP results: timezone name, approximate city, latitude, longitude,
  and the time of the last lookup.
- The extension version and small internal caches.

This data stays on the user's device. Removing the extension or clearing its
storage removes it. Raw IP addresses are not stored by the extension.

## Network requests

### GeoIP timezone lookup

Timezone protection is enabled by default. When it and the **global shield**
are enabled, the extension may request an approximate exit-point timezone from
one of these third-party GeoIP providers:

- https://ipwho.is/
- https://get.geojs.io/
- https://ipapi.co/

The providers receive the request and the user's IP address, as with any HTTPS
request. The extension uses only the returned timezone and approximate location
to keep the reported timezone consistent with the connection. The result is
cached locally, and the lookup is skipped entirely when timezone protection or
the global shield is disabled. Turn off timezone protection in the popup or
settings panel to stop these requests. Each provider's own privacy policy applies
to its processing.

### City-name localization

When the settings panel needs a localized label for a built-in city, it may
query the Wikipedia API (`https://en.wikipedia.org/w/api.php`) for the
translations of a fixed list of city names. Wikipedia receives the request, the
user's IP address, and the requested city titles. No browsing history, current
page URL, or current location is sent. Translations are cached locally.

### Other network activity

The extension does not contact developer servers. It does not upload font
lists, canvas/audio/WebGL values, WebRTC data, page content, or browsing
history. Font enumeration and fingerprint randomization happen locally.

## Permissions

- **storage**: saves settings and local caches.
- **scripting**: registers the protection scripts at document start and excludes
  bypassed sites.
- **privacy**: applies the selected WebRTC IP handling policy.
- **fontSettings**: reads the local font list for font-privacy controls.
- **declarativeNetRequest**: applies DNT/GPC headers and blocks known tracking
  domains from the bundled static rule list.
- **alarms**: refreshes the cached timezone while timezone protection is enabled.
- **&lt;all_urls&gt;**: applies protection across sites and supports the optional
  GeoIP lookup. It is also needed to exclude bypassed sites from injection.

## Data sharing and sale

No data is sold. No data is shared with advertisers, data brokers, or analytics
providers. GeoIP providers receive the IP address required to answer the lookup;
this is described above. The extension does not combine data across users.

## Children

The extension is a general-purpose privacy tool and is not directed at children
under 13. It does not knowingly collect personal information from anyone.

## Changes

Material changes to this policy will be reflected in this file and in the
extension's release notes. The "Last updated" date will be revised.

## Contact

For privacy questions or support:

- Email: CakeAlter@proton.me
- Issues: https://github.com/AsabaLazy/Bocchi/issues
- Repository: https://github.com/AsabaLazy/Bocchi
