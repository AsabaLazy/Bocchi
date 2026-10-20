'use strict';

/**
 * Bocchi Privacy Shield - Background Service Worker
 *
 * Responsibilities:
 *  - Enforce the WebRTC IP handling policy (disable_non_proxied_udp) to
 *    prevent local/non-proxied UDP IP leakage.
 *  - Periodically resolve the egress IP's timezone via GeoIP endpoints and
 *    cache it in chrome.storage.local for content scripts.
 *  - Answer GET_TIMEZONE runtime messages.
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
 * Tries ipwho.is first, then get.geojs.io and ipapi.co as fallbacks, defaulting
 * to America/Los_Angeles.
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

/**
 * Content-script registration.
 *
 * MV3 static content scripts cannot exclude hosts at runtime, so the engine
 * and bridge are registered dynamically with excludeMatches derived from the
 * per-site bypass list. Bypassed sites therefore receive NO injection at all
 * (no hooks for the page to detect) instead of injected-but-disabled code.
 * Registration persists across sessions; syncContentScripts() re-runs on
 * install/startup and whenever the bypass list changes.
 */
const CONTENT_SCRIPTS = [
  { id: 'bocchi-engine', js: ['content/stealth_engine.js'], world: 'MAIN' },
  { id: 'bocchi-bridge', js: ['content/bridge.js'], world: 'ISOLATED' }
];

function normalizeBypassHost(raw) {
  const s = String(raw || '').trim().toLowerCase();
  if (!s) return null;
  if (s.startsWith('[')) {
    const end = s.indexOf(']');
    if (end < 0) return null;
    const host = s.slice(0, end + 1);
    return /^\[[0-9a-f:.]+\]$/.test(host) ? host : null;
  }
  const host = s.replace(/^https?:\/\//, '').replace(/^\*\.?/, '').replace(/^\.+/, '').split('/')[0].split(':')[0];
  if (!host) return null;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return host;
  if (/^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(host)) return host;
  return null;
}

// Mirror the runtime bypass semantics (host === s || host.endsWith('.' + s)):
// exact host plus all subdomains; IP literals get an exact match only.
function bypassExcludeMatches(list) {
  const out = new Set();
  for (const raw of Array.isArray(list) ? list : []) {
    const host = normalizeBypassHost(raw);
    if (!host) continue;
    out.add(`*://${host}/*`);
    const isIp = /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.startsWith('[');
    if (!isIp) out.add(`*://*.${host}/*`);
  }
  return [...out];
}

async function syncContentScripts() {
  if (typeof chrome === 'undefined' || !chrome.scripting) return;
  try {
    let excludeMatches = [];
    try {
      const res = await new Promise(resolve => {
        chrome.storage.local.get(['siteBypassList'], resolve);
      });
      excludeMatches = bypassExcludeMatches(res && res.siteBypassList);
    } catch (_) {}

    const scripts = CONTENT_SCRIPTS.map(s => ({
      id: s.id,
      js: s.js,
      world: s.world,
      matches: ['<all_urls>'],
      excludeMatches,
      allFrames: true,
      matchOriginAsFallback: true,
      runAt: 'document_start',
      persistAcrossSessions: true
    }));

    const ids = CONTENT_SCRIPTS.map(s => s.id);
    const existing = await chrome.scripting.getRegisteredContentScripts();
    const registered = existing.filter(s => ids.includes(s.id));
    if (registered.length > 0) {
      await chrome.scripting.updateContentScripts(scripts);
    } else {
      await chrome.scripting.registerContentScripts(scripts);
    }
  } catch (err) {
    // Losing registration means no protection at all: surface it loudly.
    console.error('[Bocchi] content-script registration failed:', err);
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
  syncContentScripts();
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
      if (area === 'local' && changes.siteBypassList) {
        syncContentScripts();
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
