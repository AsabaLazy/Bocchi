'use strict';

/**
 * Bocchi Privacy Shield - Background Service Worker
 *
 * Responsibilities:
 *  - Enforce the WebRTC IP handling policy (disable_non_proxied_udp) to
 *    prevent local/non-proxied UDP IP leakage.
 *  - Periodically resolve the egress IP's timezone via GeoIP endpoints and
 *    cache it in chrome.storage.local for content scripts.
 *  - Answer GET_TIMEZONE / REFRESH_TIMEZONE runtime messages.
 *
 * The extension no longer spoofs any identity headers (User-Agent,
 * Client-Hints, Accept-Language): low-entropy signals are left native.
 * High-entropy fingerprint vector randomization is handled entirely by the
 * content-script engine, so no dynamic DNR rules are managed here.
 */

const DEFAULT_TIMEZONE = 'America/Los_Angeles';

/**
 * Configure WebRTC IP Handling Policy to prevent private IP and non-proxied UDP leakage.
 * Setting 'disable_non_proxied_udp' forces WebRTC traffic through proxies if configured
 * and disables unproxied UDP, effectively blocking local IPv4/IPv6 address leakage.
 */
async function applyWebRTCPolicy(specifiedEnabled) {
  if (typeof chrome !== 'undefined' && chrome.privacy && chrome.privacy.network && chrome.privacy.network.webRTCIPHandlingPolicy) {
    try {
      let isEnabled = specifiedEnabled;
      if (isEnabled === undefined && typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
        // chrome.storage.local.get always resolves asynchronously in Chrome;
        // read it via a Promise and await the result.
        try {
          const res = await new Promise(resolve => {
            chrome.storage.local.get(['globalShieldEnabled', 'webrtcProtection'], resolve);
          });
          if (res) {
            isEnabled = (res.globalShieldEnabled !== false) && (res.webrtcProtection !== false);
          }
        } catch (_) {}
      }
      if (isEnabled === undefined) {
        isEnabled = true;
      }
      const policyValue = isEnabled ? 'disable_non_proxied_udp' : 'default';
      await chrome.privacy.network.webRTCIPHandlingPolicy.set({
        value: policyValue
      });
      console.log(`[Bocchi Privacy Shield] WebRTC IP handling policy configured: ${policyValue}`);
    } catch (err) {
      console.error('[Bocchi Privacy Shield] Failed to set webRTCIPHandlingPolicy:', err);
    }
  }
}

/**
 * Fetch current egress IP geolocation and timezone from public GeoIP endpoints.
 * Tries ipwho.is first, then ipapi.co as fallback, defaulting to America/Los_Angeles.
 */
async function fetchEgressTimezone(fallback = DEFAULT_TIMEZONE) {
  const fetchOpts = (typeof AbortSignal !== 'undefined' && AbortSignal.timeout)
    ? { signal: AbortSignal.timeout(4000) }
    : {};

  // Try ipwho.is
  try {
    const res = await fetch('https://ipwho.is/', fetchOpts);
    if (res.ok) {
      const data = await res.json();
      const tz = (data && data.timezone && (data.timezone.id || data.timezone)) || data.timezone;
      if (typeof tz === 'string' && tz.includes('/')) {
        return tz;
      }
    }
  } catch (_) {}

  // Fallback to get.geojs.io
  try {
    const res = await fetch('https://get.geojs.io/v1/ip/geo.json', fetchOpts);
    if (res.ok) {
      const data = await res.json();
      if (data && typeof data.timezone === 'string' && data.timezone.includes('/')) {
        return data.timezone;
      }
    }
  } catch (_) {}

  // Fallback to ipapi.co
  try {
    const res = await fetch('https://ipapi.co/json/', fetchOpts);
    if (res.ok) {
      const data = await res.json();
      if (data && typeof data.timezone === 'string' && data.timezone.includes('/')) {
        return data.timezone;
      }
    }
  } catch (_) {}

  return fallback;
}

const TIMEZONE_CACHE_TTL_MS = 4 * 60 * 60 * 1000; // 4-hour GeoIP cache TTL

/**
 * Sync egress IP timezone to chrome.storage.local for content scripts to consume.
 * Checks cache TTL before making outbound network requests unless force is true.
 */
async function syncTimezone(force = false) {
  try {
    if (!force && typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
      const cached = await chrome.storage.local.get(['timezone', 'lastUpdated']);
      if (cached && cached.timezone && cached.lastUpdated && (Date.now() - cached.lastUpdated < TIMEZONE_CACHE_TTL_MS)) {
        return cached.timezone;
      }
    }

    const tz = await fetchEgressTimezone();
    if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
      await chrome.storage.local.set({
        timezone: tz,
        lastUpdated: Date.now()
      });
      console.log('[Bocchi Privacy Shield] Egress timezone synchronized:', tz);
    }
    return tz;
  } catch (err) {
    console.error('[Bocchi Privacy Shield] Failed to sync timezone:', err);
    return DEFAULT_TIMEZONE;
  }
}

function setupPeriodicTimezoneAlarm() {
  if (typeof chrome !== 'undefined' && chrome.alarms) {
    try {
      chrome.alarms.create('bocchi_tz_sync', { periodInMinutes: 60 });
    } catch (_) {}
  }
}

function init() {
  applyWebRTCPolicy();
  syncTimezone();
  setupPeriodicTimezoneAlarm();
}

// Apply immediately when service worker starts
init();

// Ensure WebRTC policy, timezone, and alarms are refreshed on extension installation or update
if (typeof chrome !== 'undefined' && chrome.runtime) {
  ['onInstalled', 'onStartup'].forEach(event => {
    if (chrome.runtime[event]) {
      chrome.runtime[event].addListener(init);
    }
  });

  if (typeof chrome !== 'undefined' && chrome.alarms && chrome.alarms.onAlarm) {
    chrome.alarms.onAlarm.addListener((alarm) => {
      if (alarm && alarm.name === 'bocchi_tz_sync') {
        syncTimezone(true);
      }
    });
  }

  if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.onChanged && chrome.storage.onChanged.addListener) {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'local' && (changes.globalShieldEnabled || changes.webrtcProtection)) {
        applyWebRTCPolicy();
      }
    });
  }

  if (chrome.runtime.onMessage) {
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
      if (message && message.type === 'GET_TIMEZONE') {
        (async () => {
          if (chrome.storage && chrome.storage.local) {
            const res = await chrome.storage.local.get(['timezone']);
            sendResponse({ timezone: (res && res.timezone) || DEFAULT_TIMEZONE });
          } else {
            sendResponse({ timezone: DEFAULT_TIMEZONE });
          }
        })();
        return true;
      } else if (message && message.type === 'REFRESH_TIMEZONE') {
        (async () => {
          const tz = await syncTimezone(true);
          sendResponse({ timezone: tz });
        })();
        return true;
      }
    });
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    DEFAULT_TIMEZONE,
    applyWebRTCPolicy,
    fetchEgressTimezone,
    syncTimezone
  };
}
