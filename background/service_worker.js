'use strict';

const DEFAULT_TIMEZONE = 'America/Los_Angeles';

/**
 * Configure WebRTC IP Handling Policy to prevent private IP and non-proxied UDP leakage.
 * Setting 'disable_non_proxied_udp' forces WebRTC traffic through proxies if configured
 * and disables unproxied UDP, effectively blocking local IPv4/IPv6 address leakage.
 */
async function applyWebRTCPolicy() {
  if (typeof chrome !== 'undefined' && chrome.privacy && chrome.privacy.network && chrome.privacy.network.webRTCIPHandlingPolicy) {
    try {
      await chrome.privacy.network.webRTCIPHandlingPolicy.set({
        value: 'disable_non_proxied_udp'
      });
      console.log('[Bocchi Privacy Shield] WebRTC IP handling policy configured: disable_non_proxied_udp');
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
  // Try ipwho.is
  try {
    const res = await fetch('https://ipwho.is/');
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
    const res = await fetch('https://get.geojs.io/v1/ip/geo.json');
    if (res.ok) {
      const data = await res.json();
      if (data && typeof data.timezone === 'string' && data.timezone.includes('/')) {
        return data.timezone;
      }
    }
  } catch (_) {}

  // Fallback to ipapi.co
  try {
    const res = await fetch('https://ipapi.co/json/');
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

/**
 * Synchronize HTTP Request User-Agent and Client Hints with native Linux Chromium profile.
 * Prevents "server UA differs from browser UA" and OS mismatch detection.
 */
async function syncUserAgentRule() {
  if (typeof chrome !== 'undefined' && chrome.declarativeNetRequest && chrome.declarativeNetRequest.updateDynamicRules) {
    try {
      const realUA = (typeof navigator !== 'undefined' && navigator.userAgent) || '';
      let linuxUA = realUA.includes('Chrome/')
        ? realUA.replace('HeadlessChrome/', 'Chrome/')
        : 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36';

      if (!linuxUA.includes('Linux')) {
        linuxUA = linuxUA.replace(/\(([^)]+)\)/, '(X11; Linux x86_64)');
      }

      const match = linuxUA.match(/Chrome\/([\d.]+)/);
      const fullVer = match ? match[1] : '153.0.0.0';
      const chromeVer = fullVer.split('.')[0] || '153';

      const isGoogleChrome = realUA.includes('Google Chrome');
      const brands = isGoogleChrome
        ? `"Google Chrome";v="${chromeVer}", "Chromium";v="${chromeVer}", "Not_A Brand";v="8"`
        : `"Chromium";v="${chromeVer}", "Not_A Brand";v="8"`;
      const fullVersionList = isGoogleChrome
        ? `"Google Chrome";v="${fullVer}", "Chromium";v="${fullVer}", "Not_A Brand";v="8.0.0.0"`
        : `"Chromium";v="${fullVer}", "Not_A Brand";v="8.0.0.0"`;

      await chrome.declarativeNetRequest.updateDynamicRules({
        removeRuleIds: [1001],
        addRules: [{
          id: 1001,
          priority: 10,
          action: {
            type: 'modifyHeaders',
            requestHeaders: [
              { header: 'User-Agent', operation: 'set', value: linuxUA },
              { header: 'Sec-CH-UA-Platform', operation: 'set', value: '"Linux"' },
              { header: 'Sec-CH-UA-Platform-Version', operation: 'set', value: '""' },
              { header: 'Sec-CH-UA-Mobile', operation: 'set', value: '?0' },
              { header: 'Sec-CH-UA', operation: 'set', value: brands },
              { header: 'Sec-CH-UA-Full-Version', operation: 'set', value: `"${fullVer}"` },
              { header: 'Sec-CH-UA-Full-Version-List', operation: 'set', value: fullVersionList },
              { header: 'Sec-CH-UA-Arch', operation: 'set', value: '"x86"' },
              { header: 'Sec-CH-UA-Bitness', operation: 'set', value: '"64"' }
            ]
          },
          condition: {
            urlFilter: '*',
            resourceTypes: ['main_frame', 'sub_frame', 'stylesheet', 'script', 'image', 'font', 'object', 'xmlhttprequest', 'ping', 'csp_report', 'media', 'websocket', 'other']
          }
        }]
      });
      console.log('[Bocchi Privacy Shield] Dynamic Linux User-Agent rule applied:', linuxUA);
    } catch (err) {
      console.error('[Bocchi Privacy Shield] Failed to update dynamic DNR UA rule:', err);
    }
  }
}

function init() {
  applyWebRTCPolicy();
  syncTimezone();
  syncUserAgentRule();
}

// Apply immediately when service worker starts
init();

// Ensure policy and timezone are refreshed on extension installation or update
if (typeof chrome !== 'undefined' && chrome.runtime) {
  ['onInstalled', 'onStartup'].forEach(event => {
    if (chrome.runtime[event]) {
      chrome.runtime[event].addListener(init);
    }
  });

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
    syncTimezone,
    syncUserAgentRule
  };
}
