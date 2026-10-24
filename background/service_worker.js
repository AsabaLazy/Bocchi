'use strict';

/**
 * Bocchi Privacy Shield - Background Service Worker
 *
 * Responsibilities:
 *  - Enforce the WebRTC IP handling policy from the independent UDP-block and
 *    local-IP-cleaning switches.
 *  - Periodically resolve the egress IP's timezone via GeoIP endpoints and
 *    cache it in chrome.storage.local for content scripts.
 *  - Answer GET_TIMEZONE / SYNC_EGRESS runtime messages.
 *  - Keep the dynamic Accept-Language rule, the static ruleset switch and the
 *    dynamic content-script registrations in sync with storage.
 *
 * User-Agent and Client-Hints stay native. Accept-Language is opt-in via the
 * language module; the dynamic DNR rule below is the only header managed here.
 * High-entropy fingerprint vector randomization is handled entirely by the
 * content-script engine.
 */

const DEFAULT_TIMEZONE = 'America/Los_Angeles';

/* ------------------------------------------------------------------ *
 * WebRTC
 * ------------------------------------------------------------------ */

/**
 * Configure WebRTC IP Handling Policy from the three independent WebRTC
 * options:
 * - webrtcUdp on: disable_non_proxied_udp (strongest, can break video calls).
 * - webrtcUdp off + webrtcLocalIp on: default_public_interface_only keeps
 *   video calls working while hiding private interfaces (public IP may leak).
 * - both off: browser default.
 */
async function applyWebRTCPolicy(specifiedEnabled) {
  if (typeof chrome !== 'undefined' && chrome.privacy && chrome.privacy.network && chrome.privacy.network.webRTCIPHandlingPolicy) {
    try {
      let isEnabled = specifiedEnabled;
      let udpBlock = false;
      let localIpClean = true;
      if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
        // chrome.storage.local.get always resolves asynchronously in Chrome;
        // read it via a Promise and await the result.
        try {
          const res = await new Promise(resolve => {
            chrome.storage.local.get(['globalShieldEnabled', 'webrtcProtection', 'webrtcUdp', 'webrtcLocalIp'], resolve);
          });
          if (res) {
            if (isEnabled === undefined) {
              isEnabled = (res.globalShieldEnabled !== false) && (res.webrtcProtection !== false);
            }
            udpBlock = res.webrtcUdp === true;
            localIpClean = res.webrtcLocalIp !== false;
          }
        } catch (_) {}
      }
      if (isEnabled === undefined) {
        isEnabled = true;
      }
      const policyValue = !isEnabled
        ? 'default'
        : (udpBlock ? 'disable_non_proxied_udp' : (localIpClean ? 'default_public_interface_only' : 'default'));
      await chrome.privacy.network.webRTCIPHandlingPolicy.set({
        value: policyValue
      });
      console.log(`[Bocchi Privacy Shield] WebRTC IP handling policy configured: ${policyValue}`);
    } catch (err) {
      console.error('[Bocchi Privacy Shield] Failed to set webRTCIPHandlingPolicy:', err);
    }
  }
}

/* ------------------------------------------------------------------ *
 * GeoIP
 * ------------------------------------------------------------------ */

const GEOIP_PROVIDER_TIMEOUT_MS = 4000; // per-provider budget
const GEOIP_TOTAL_BUDGET_MS = 10000;    // whole lookup budget
const GEOIP_FAILURE_BACKOFF_MS = 10 * 60 * 1000; // 10-minute failure cooldown
const TIMEZONE_CACHE_TTL_MS = 4 * 60 * 60 * 1000; // 4-hour GeoIP cache TTL

// Storage keys used to remember failed lookups so a service-worker restart or
// a chatty page cannot keep hitting third-party GeoIP providers.
const GEO_LAST_ATTEMPT_KEY = 'geoLastAttempt';
const GEO_FAILURE_UNTIL_KEY = 'geoFailureUntil';

/**
 * Accept only IANA-shaped zone ids that the runtime actually understands.
 * Rejects arbitrary strings from storage or a compromised provider response.
 */
function isValidTimezone(value) {
  if (typeof value !== 'string') return false;
  const tz = value.trim();
  if (!tz || tz.length > 64) return false;
  if (!/^[A-Za-z][A-Za-z0-9_+\-]*(?:\/[A-Za-z0-9_+\-]+)*$/.test(tz)) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch (_) {
    return false;
  }
}

/**
 * Per-provider timeout. AbortSignal.timeout() is preferred because a single
 * shared signal would let the slowest provider abort the fallbacks that run
 * after it.
 */
function createTimeoutController(timeoutMs) {
  if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
    try {
      return { signal: AbortSignal.timeout(timeoutMs), clear() {} };
    } catch (_) {}
  }
  if (typeof AbortController !== 'undefined') {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      try { controller.abort(); } catch (_) {}
    }, timeoutMs);
    return {
      signal: controller.signal,
      clear() { clearTimeout(timer); }
    };
  }
  return { signal: undefined, clear() {} };
}

function toFiniteNumber(value) {
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  if (typeof value === 'string' && value.trim() === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function readGeo(data) {
  const rawLat = data ? (data.latitude != null ? data.latitude : data.lat) : null;
  const rawLng = data ? (data.longitude != null ? data.longitude : data.lon) : null;
  const lat = toFiniteNumber(rawLat);
  const lng = toFiniteNumber(rawLng);
  const validLat = lat !== null && lat >= -90 && lat <= 90;
  const validLng = lng !== null && lng >= -180 && lng <= 180;
  return {
    lat: validLat ? lat : null,
    lng: validLng ? lng : null,
    city: data && typeof data.city === 'string' ? data.city : ''
  };
}

async function fetchGeoProvider(url, parse, deadline) {
  const remaining = deadline - Date.now();
  if (remaining <= 0) return null;
  const timeout = Math.min(GEOIP_PROVIDER_TIMEOUT_MS, remaining);
  const controller = createTimeoutController(timeout);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      cache: 'no-store',
      credentials: 'omit'
    });
    if (!res || !res.ok) return null;
    const data = await res.json();
    const info = parse(data);
    return info || null;
  } catch (_) {
    return null;
  } finally {
    controller.clear();
  }
}

/**
 * Fetch current egress IP geolocation and timezone from public GeoIP
 * endpoints. Each provider gets its own timeout; the whole lookup is bounded
 * by GEOIP_TOTAL_BUDGET_MS.
 *
 * By default the first provider returning a valid timezone wins (timezone is
 * the only value the content engine needs, and extra providers expose the IP
 * to more third parties). A provider may omit coordinates, though, so callers
 * that specifically need the map location can pass:
 *   - preferCoordinates: keep asking later providers for coordinates, but
 *     still return the first timezone-only result if none has coordinates.
 *   - requireCoordinates: accept only provider responses with both latitude
 *     and longitude; return ok:false if no provider supplies them.
 *
 * Returns an explicit status so callers can avoid overwriting a good cache
 * with the fallback default when every provider fails.
 */
async function fetchEgressInfo(fallback = DEFAULT_TIMEZONE, options = {}) {
  // Allow fetchEgressInfo({ preferCoordinates: true }) as a convenience while
  // keeping the historical fallback-first signature.
  if (fallback && typeof fallback === 'object') {
    options = fallback;
    fallback = DEFAULT_TIMEZONE;
  }
  const opts = options && typeof options === 'object' ? options : {};
  const requireCoordinates = opts.requireCoordinates === true;
  const preferCoordinates = requireCoordinates || opts.preferCoordinates === true;

  const deadline = Date.now() + GEOIP_TOTAL_BUDGET_MS;

  const parseIpWho = (data) => {
    if (!data || data.success === false) return null;
    const raw = data.timezone && (data.timezone.id || data.timezone);
    if (!isValidTimezone(raw)) return null;
    return { timezone: raw.trim(), ...readGeo(data) };
  };
  const parseGeojs = (data) => {
    if (!data || !isValidTimezone(data.timezone)) return null;
    return { timezone: data.timezone.trim(), ...readGeo(data) };
  };
  const parseIpapi = (data) => {
    if (!data || data.error || !isValidTimezone(data.timezone)) return null;
    return { timezone: data.timezone.trim(), ...readGeo(data) };
  };

  const providers = [
    ['https://ipwho.is/', parseIpWho],
    ['https://get.geojs.io/v1/ip/geo.json', parseGeojs],
    ['https://ipapi.co/json/', parseIpapi]
  ];

  let timezoneOnly = null;
  for (const [url, parse] of providers) {
    const info = await fetchGeoProvider(url, parse, deadline);
    if (!info) continue;

    // Both coordinates are required for a usable location; a single axis is
    // never enough to place the user on the map.
    const hasCoordinates = typeof info.lat === 'number' && typeof info.lng === 'number';

    if (!preferCoordinates) return { ok: true, ...info };
    if (hasCoordinates) return { ok: true, ...info };
    if (!timezoneOnly) timezoneOnly = info;
    // requireCoordinates: keep looking; a coordinate-less provider is not a
    // valid answer for this caller. preferCoordinates: also keep looking, but
    // retain the first timezone-only answer as a fallback.
  }

  if (timezoneOnly && !requireCoordinates) {
    return { ok: true, ...timezoneOnly };
  }

  return {
    ok: false,
    timezone: fallback,
    lat: null,
    lng: null,
    city: ''
  };
}

async function fetchEgressTimezone(fallback = DEFAULT_TIMEZONE, options = {}) {
  const info = await fetchEgressInfo(fallback, options);
  return info.timezone;
}

// Serialize sync requests. Top-level init, storage changes, runtime messages
// and the periodic alarm can race on a fresh service-worker wake; a serial
// queue prevents duplicate network calls while still letting an explicit
// force-sync (panel button / alarm) run after an in-flight non-forced read.
let timezoneSyncTail = Promise.resolve();

async function syncTimezoneNow(force, options) {
  let cached = {};
  const storageAvailable = typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local;
  if (storageAvailable) {
    cached = await chrome.storage.local.get([
      'timezone', 'lastUpdated', 'ipLatitude', 'ipLongitude', 'ipCity',
      'globalShieldEnabled', 'timezoneProtection',
      GEO_LAST_ATTEMPT_KEY, GEO_FAILURE_UNTIL_KEY
    ]);
    cached = cached || {};
  }

  const cachedTimezone = isValidTimezone(cached.timezone) ? cached.timezone.trim() : '';

  // GeoIP lookups are third-party requests that expose the user's IP.
  // Never perform them while the global shield or timezone protection is off.
  // Returning the cache without writing keeps a toggle-off from touching it.
  const timezoneEnabled = cached.globalShieldEnabled !== false && cached.timezoneProtection !== false;
  if (!timezoneEnabled) return cachedTimezone || DEFAULT_TIMEZONE;

  const now = Date.now();
  const lastUpdated = Number(cached.lastUpdated);
  const cacheFresh = cachedTimezone &&
    Number.isFinite(lastUpdated) && lastUpdated > 0 &&
    now >= lastUpdated && (now - lastUpdated < TIMEZONE_CACHE_TTL_MS);

  // TTL is based only on a valid zone id plus lastUpdated; coordinates are
  // optional because some providers omit them.
  if (!force && cacheFresh) return cachedTimezone;

  // After a failed lookup, stay quiet for a while instead of exposing the IP
  // to every provider again on the next service-worker wake. A user-initiated
  // forced refresh is allowed through so the panel's sync action still works.
  const failureUntil = Number(cached[GEO_FAILURE_UNTIL_KEY]);
  if (!force && Number.isFinite(failureUntil) && failureUntil > now) {
    return cachedTimezone || DEFAULT_TIMEZONE;
  }

  // A user-initiated forced refresh prefers coordinates so the panel map can
  // be filled even when the first provider only knows the timezone. Normal
  // syncs keep timezone-first semantics and stay within the failure backoff.
  const fetchOptions = force
    ? Object.assign({ preferCoordinates: true }, options || {})
    : (options || {});
  const info = await fetchEgressInfo(DEFAULT_TIMEZONE, fetchOptions);
  const attemptedAt = Date.now();

  if (!storageAvailable) {
    return info.ok ? info.timezone : (cachedTimezone || DEFAULT_TIMEZONE);
  }

  if (!info.ok) {
    // Never overwrite a valid timezone/coordinate cache with fallback data.
    // Only record the attempt so the backoff survives a worker restart.
    try {
      await chrome.storage.local.set({
        [GEO_LAST_ATTEMPT_KEY]: attemptedAt,
        [GEO_FAILURE_UNTIL_KEY]: attemptedAt + GEOIP_FAILURE_BACKOFF_MS
      });
    } catch (err) {
      console.error('[Bocchi Privacy Shield] Failed to persist GeoIP backoff:', err);
    }
    console.warn('[Bocchi Privacy Shield] GeoIP lookup failed; keeping cached timezone.');
    return cachedTimezone || DEFAULT_TIMEZONE;
  }

  const timezoneChanged = !!cachedTimezone && cachedTimezone !== info.timezone;
  const lat = typeof info.lat === 'number'
    ? info.lat
    : (!timezoneChanged && typeof cached.ipLatitude === 'number' ? cached.ipLatitude : null);
  const lng = typeof info.lng === 'number'
    ? info.lng
    : (!timezoneChanged && typeof cached.ipLongitude === 'number' ? cached.ipLongitude : null);
  const city = info.city || (!timezoneChanged && typeof cached.ipCity === 'string' ? cached.ipCity : '');
  const hasCoordinates = lat !== null && lng !== null;

  // A provider may return a valid timezone without coordinates. Still cache
  // the timezone and lastUpdated so the bridge/config sees it and repeated
  // service-worker wakes do not re-query. A forced sync uses
  // preferCoordinates to ask later providers for the map location; if the
  // egress timezone changed and no provider had coordinates, drop the stale
  // location instead of pairing the new zone with an old city.
  if (!hasCoordinates) {
    console.warn('[Bocchi Privacy Shield] GeoIP response had no coordinates; caching timezone only.');
  }

  try {
    await chrome.storage.local.set({
      timezone: info.timezone,
      ipLatitude: lat,
      ipLongitude: lng,
      ipCity: city,
      lastUpdated: attemptedAt,
      [GEO_LAST_ATTEMPT_KEY]: attemptedAt,
      [GEO_FAILURE_UNTIL_KEY]: 0
    });
    console.log('[Bocchi Privacy Shield] Egress timezone synchronized:', info.timezone);
  } catch (err) {
    console.error('[Bocchi Privacy Shield] Failed to cache egress timezone:', err);
  }
  return info.timezone;
}

function syncTimezone(force = false, options) {
  const task = timezoneSyncTail.then(() => syncTimezoneNow(force, options)).catch((err) => {
    console.error('[Bocchi Privacy Shield] Failed to sync timezone:', err);
    return DEFAULT_TIMEZONE;
  });
  // Keep the queue alive after a rejected task; the caller still receives the
  // rejection/result from `task`.
  timezoneSyncTail = task.then(() => undefined, () => undefined);
  return task;
}

/* ------------------------------------------------------------------ *
 * Serial work queues
 * ------------------------------------------------------------------ */

/**
 * Small promise chain used to serialize operations that cannot overlap:
 * getDynamicRules/updateDynamicRules would otherwise race and collide on
 * rule id 9001, and content-script update/register calls can race the same
 * registration id.
 */
function createSerialQueue() {
  let tail = Promise.resolve();
  return function enqueue(task) {
    const run = tail.then(task, task);
    tail = run.catch(() => {});
    return run;
  };
}

const enqueueDnr = createSerialQueue();
const enqueueContentScripts = createSerialQueue();

async function withRetry(label, fn, attempts = 2) {
  let lastErr = null;
  for (let i = 0; i < attempts; i += 1) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (i === 0) console.warn(`[Bocchi Privacy Shield] ${label} failed, retrying:`, err);
    }
  }
  throw lastErr;
}

/* ------------------------------------------------------------------ *
 * Static DNR ruleset (DNT / Sec-GPC / tracker blocks)
 * ------------------------------------------------------------------ */

const STATIC_RULESET_ID = 'cyt_rules';

async function syncStaticRulesetNow() {
  const dnr = (typeof chrome !== 'undefined') ? chrome.declarativeNetRequest : null;
  if (!dnr || typeof dnr.updateEnabledRulesets !== 'function') return;

  let enabled = true;
  try {
    const res = await withRetry('read global shield state',
      () => chrome.storage.local.get(['globalShieldEnabled']));
    enabled = !res || res.globalShieldEnabled !== false;
  } catch (err) {
    // Without a confirmed target we must not guess: log loudly and leave the
    // currently enabled/disabled rulesets untouched.
    console.error('[Bocchi Privacy Shield] Failed to read global shield state after retry; static ruleset left unchanged:', err);
    return;
  }

  try {
    let currentlyEnabled = null;
    if (typeof dnr.getEnabledRulesets === 'function') {
      try {
        const ids = await withRetry('list static rulesets', () => dnr.getEnabledRulesets());
        if (Array.isArray(ids)) currentlyEnabled = ids.includes(STATIC_RULESET_ID);
      } catch (err) {
        // The target state is known even if the current state is not; the
        // update below is idempotent, so apply it rather than silently
        // keeping a stale DNT/Sec-GPC/tracker ruleset state.
        console.error('[Bocchi Privacy Shield] Failed to list static rulesets after retry; applying target state:', err);
      }
    }
    if (currentlyEnabled === enabled) return;

    const opts = enabled
      ? { enableRulesetIds: [STATIC_RULESET_ID] }
      : { disableRulesetIds: [STATIC_RULESET_ID] };
    await withRetry('static ruleset toggle', () => dnr.updateEnabledRulesets(opts));
    console.log(`[Bocchi Privacy Shield] Static ruleset ${STATIC_RULESET_ID} ${enabled ? 'enabled' : 'disabled'}.`);
  } catch (err) {
    console.error('[Bocchi Privacy Shield] Failed to toggle static ruleset:', err);
  }
}

function syncStaticRuleset() {
  return enqueueDnr(syncStaticRulesetNow);
}

/* ------------------------------------------------------------------ *
 * Content-script registration
 * ------------------------------------------------------------------ */

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

function isIPv4Literal(host) {
  const parts = host.split('.');
  return parts.length === 4 && parts.every(p => /^\d{1,3}$/.test(p) && Number(p) <= 255);
}

function parseIPv6Groups(inner) {
  if (!inner || inner.includes('%')) return null;
  const halves = inner.split('::');
  if (halves.length > 2) return null;
  const parseHalf = (part) => {
    if (part === '') return [];
    const groups = [];
    const segments = part.split(':');
    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i];
      if (!seg) return null;
      if (i === segments.length - 1 && seg.includes('.')) {
        if (!isIPv4Literal(seg)) return null;
        groups.push(0, 0);
      } else if (/^[0-9a-f]{1,4}$/i.test(seg)) {
        groups.push(parseInt(seg, 16));
      } else {
        return null;
      }
    }
    return groups;
  };
  const head = parseHalf(halves[0]);
  const tail = halves.length === 2 ? parseHalf(halves[1]) : [];
  if (!head || !tail) return null;
  // "::" must compress at least one 16-bit group.
  return halves.length === 2
    ? (head.length + tail.length < 8 ? head.concat(tail) : null)
    : (head.length === 8 ? head : null);
}

function isIPv6Literal(host) {
  if (typeof host !== 'string' || host.length < 3 || host[0] !== '[' || host[host.length - 1] !== ']') return false;
  return parseIPv6Groups(host.slice(1, -1)) !== null;
}

function isIpLiteral(host) {
  return isIPv4Literal(host) || isIPv6Literal(host);
}

// A public suffix must never become a bypass entry: `com` would produce
// `*://*.com/*` and disable injection for every .com site, and `co.uk` would
// do the same for all .co.uk sites. This mirrors the panel's validation for
// direct/imported storage values as well. `localhost` (and *.localhost) and
// valid IP literals remain allowed.
const PUBLIC_SUFFIX_SINGLE = new Set([
  'com', 'net', 'org', 'edu', 'gov', 'mil', 'int', 'arpa',
  'info', 'biz', 'name', 'mobi', 'asia', 'pro', 'tel', 'cat', 'jobs', 'aero', 'coop', 'museum', 'travel',
  'app', 'dev', 'xyz', 'top', 'site', 'online', 'shop', 'store', 'tech', 'cloud', 'club', 'live',
  'fun', 'icu', 'vip', 'work', 'space', 'website', 'agency', 'digital', 'email', 'media', 'news',
  'blog', 'page', 'link', 'click', 'download', 'stream', 'review', 'support', 'solutions', 'services',
  'systems', 'network', 'zone', 'world', 'today', 'life', 'style', 'art', 'design', 'studio',
  'company', 'center', 'academy', 'education', 'school', 'university', 'institute', 'foundation',
  'community', 'social', 'global', 'international', 'group', 'team', 'plus', 'one'
]);

const PUBLIC_SUFFIX_ONLY_HOSTS = new Set([
  // Single-label TLDs are handled generically; these are the common
  // multi-label public suffixes (ccTLD second levels and shared hosts).
  'ac.uk', 'co.uk', 'gov.uk', 'ltd.uk', 'me.uk', 'net.uk', 'nhs.uk', 'org.uk', 'plc.uk', 'police.uk', 'sch.uk',
  'ac.cn', 'com.cn', 'edu.cn', 'gov.cn', 'mil.cn', 'net.cn', 'org.cn',
  'ac.jp', 'ad.jp', 'co.jp', 'ed.jp', 'go.jp', 'gr.jp', 'lg.jp', 'ne.jp', 'or.jp',
  'asn.au', 'com.au', 'edu.au', 'gov.au', 'id.au', 'net.au', 'org.au',
  'ac.nz', 'co.nz', 'geek.nz', 'gen.nz', 'govt.nz', 'kiwi.nz', 'maori.nz', 'net.nz', 'org.nz', 'school.nz',
  'co.kr', 'go.kr', 'mil.kr', 'ne.kr', 'or.kr', 'pe.kr', 're.kr',
  'com.br', 'edu.br', 'gov.br', 'net.br', 'org.br',
  'ac.in', 'co.in', 'edu.in', 'firm.in', 'gen.in', 'gov.in', 'ind.in', 'mil.in', 'net.in', 'org.in',
  'com.tw', 'edu.tw', 'gov.tw', 'idv.tw', 'net.tw', 'org.tw',
  'com.hk', 'edu.hk', 'gov.hk', 'idv.hk', 'net.hk', 'org.hk',
  'com.sg', 'edu.sg', 'gov.sg', 'net.sg', 'org.sg', 'per.sg',
  'ac.za', 'co.za', 'edu.za', 'gov.za', 'net.za', 'org.za',
  'com.mx', 'edu.mx', 'gob.mx', 'net.mx', 'org.mx',
  'com.tr', 'edu.tr', 'gov.tr', 'net.tr', 'org.tr',
  'ac.il', 'co.il', 'gov.il', 'muni.il', 'net.il', 'org.il',
  'com.ar', 'edu.ar', 'gob.ar', 'gov.ar', 'net.ar', 'org.ar',
  'com.co', 'edu.co', 'gov.co', 'net.co', 'org.co',
  'com.pe', 'edu.pe', 'gob.pe', 'net.pe', 'org.pe',
  'com.cl', 'edu.cl', 'gob.cl', 'gov.cl', 'net.cl', 'org.cl',
  'ac.id', 'co.id', 'go.id', 'mil.id', 'net.id', 'or.id', 'web.id',
  'ac.th', 'co.th', 'go.th', 'in.th', 'net.th', 'or.th',
  'ac.ke', 'co.ke', 'go.ke', 'ne.ke', 'or.ke', 'sc.ke',
  'com.ng', 'edu.ng', 'gov.ng', 'net.ng', 'org.ng',
  'com.eg', 'edu.eg', 'gov.eg', 'net.eg', 'org.eg',
  'github.io', 'gitlab.io', 'herokuapp.com', 'netlify.app', 'pages.dev', 'vercel.app'
]);

function isBarePublicSuffix(host) {
  if (host === 'localhost' || host.endsWith('.localhost')) return false;
  // Reject bare gTLDs/ccTLDs, but keep ordinary single-label intranet hosts
  // (e.g. `myserver`) usable. Wildcard exclusions are only added for
  // multi-label hosts below, so a single label can never exclude a whole TLD.
  if (!host.includes('.')) {
    return /^[a-z]{2}$/.test(host) || PUBLIC_SUFFIX_SINGLE.has(host);
  }
  return PUBLIC_SUFFIX_ONLY_HOSTS.has(host);
}

function normalizeBypassHost(raw) {
  let s = String(raw || '').trim().toLowerCase();
  if (!s) return null;
  if (/^[a-z][a-z0-9+.-]*:\/\//.test(s)) {
    s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//, '').split(/[/?#]/)[0];
    const at = s.lastIndexOf('@');
    if (at >= 0) s = s.slice(at + 1);
  }
  s = s.replace(/^\*\.?/, '').replace(/^\.+/, '');
  if (s.startsWith('[')) {
    const end = s.indexOf(']');
    if (end < 0) return null;
    const host = s.slice(0, end + 1);
    return isIPv6Literal(host) ? host : null;
  }
  const host = s.split('/')[0].split(':')[0].replace(/\.+$/, '');
  if (!host) return null;
  if (isIPv4Literal(host)) return host;
  if (!/^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(host)) return null;
  return isBarePublicSuffix(host) ? null : host;
}

// Mirror the runtime bypass semantics (host === s || host.endsWith('.' + s)):
// exact host plus all subdomains; IP literals get an exact match only.
function bypassExcludeMatches(list) {
  const out = new Set();
  for (const raw of Array.isArray(list) ? list : []) {
    const host = normalizeBypassHost(raw);
    if (!host) continue;
    out.add(`*://${host}/*`);
    if (!isIpLiteral(host)) out.add(`*://*.${host}/*`);
  }
  return [...out];
}

// DNR accepts domain names and IP literals in excluded*Domains; invalid
// imports are dropped instead of invalidating the whole rule update. Array
// methods (rather than a Set spread) keep the result usable by callers that
// compare realms in tests and preserve input order.
function bypassDomains(list) {
  if (!Array.isArray(list)) return [];
  return list
    .map(raw => normalizeBypassHost(raw))
    .filter((host, index, all) => host && all.indexOf(host) === index);
}

function contentScriptDefinition(spec, excludeMatches) {
  return {
    id: spec.id,
    js: spec.js,
    world: spec.world,
    matches: ['<all_urls>'],
    excludeMatches,
    allFrames: true,
    matchOriginAsFallback: true,
    runAt: 'document_start',
    persistAcrossSessions: true
  };
}

async function repairContentScript(spec, excludeMatches, wasRegistered, originalError, scripting) {
  console.error(`[Bocchi Privacy Shield] Content script ${spec.id} sync failed; retrying without bypass exclusions:`, originalError);
  // Never unregister first: a failed re-registration would disable protection
  // on every site. Prefer a safe update/registration without excludeMatches;
  // the bypass list may be temporarily ineffective, but the shield stays on.
  const safeDefinition = contentScriptDefinition(spec, []);
  // matchOriginAsFallback was added after this extension's minimum Chrome
  // version; omit it from the emergency definition so an older browser can
  // still register the protection.
  delete safeDefinition.matchOriginAsFallback;
  try {
    if (wasRegistered) {
      await withRetry(`update content script ${spec.id} (safe)`,
        () => scripting.updateContentScripts([safeDefinition]));
    } else {
      await withRetry(`register content script ${spec.id} (safe)`,
        () => scripting.registerContentScripts([safeDefinition]));
    }
    console.error(`[Bocchi Privacy Shield] ${spec.id} registered without bypass exclusions; remove invalid entries from the exception list.`);
    return true;
  } catch (fallbackErr) {
    console.error(`[Bocchi Privacy Shield] Content script ${spec.id} could not be registered safely:`, fallbackErr);
    return false;
  }
}

const CONTENT_SCRIPT_IDS = new Set(CONTENT_SCRIPTS.map(spec => spec.id));

function isNonexistentScriptError(err) {
  const message = err && (err.message || String(err));
  return /nonexistent|does not exist|not found|no script with id/i.test(message || '');
}

async function syncContentScriptsNow() {
  if (typeof chrome === 'undefined' || !chrome.scripting) return;
  const scripting = chrome.scripting;
  if (typeof scripting.getRegisteredContentScripts !== 'function' ||
      typeof scripting.updateContentScripts !== 'function' ||
      typeof scripting.registerContentScripts !== 'function') {
    return;
  }

  let excludeMatches = [];
  let shieldEnabled = true;
  try {
    // A transient storage failure must never be interpreted as "shield on +
    // empty bypass list": that would re-register scripts while the shield is
    // globally off or lose every exclusion. Keep the current registrations.
    const res = await withRetry('read content-script config',
      () => chrome.storage.local.get(['siteBypassList', 'globalShieldEnabled']));
    excludeMatches = bypassExcludeMatches(res && res.siteBypassList);
    shieldEnabled = !res || res.globalShieldEnabled !== false;
  } catch (err) {
    console.error('[Bocchi Privacy Shield] Failed to read bypass list after retry; keeping current content-script registrations:', err);
    return;
  }

  // Global off means no MAIN-world hook should run at all, even before the
  // bridge's async config arrives. Remove the registrations instead of injecting
  // an inert engine that an early inline script could still detect.
  if (!shieldEnabled) {
    if (typeof scripting.unregisterContentScripts !== 'function') return;

    // Only unregister IDs that actually exist. Chrome rejects the whole
    // unregisterContentScripts() call when any listed ID is absent, which
    // would leave the other script injecting while the shield is off.
    let existing = [];
    try {
      existing = await withRetry('list content scripts (shield off)',
        () => scripting.getRegisteredContentScripts());
    } catch (err) {
      console.error('[Bocchi Privacy Shield] Failed to list content scripts after retry; keeping current registrations:', err);
      return;
    }
    if (!Array.isArray(existing)) {
      console.error('[Bocchi Privacy Shield] Content-script list was not an array; keeping current registrations.');
      return;
    }
    const ids = existing
      .map(script => script && script.id)
      .filter(id => CONTENT_SCRIPT_IDS.has(id));
    if (!ids.length) return;

    try {
      await withRetry('unregister content scripts (shield off)',
        () => scripting.unregisterContentScripts({ ids }));
    } catch (err) {
      console.error('[Bocchi Privacy Shield] Failed to unregister content scripts; retrying per ID:', err);
      for (const id of ids) {
        try {
          await scripting.unregisterContentScripts({ ids: [id] });
        } catch (idErr) {
          // A concurrent sync may have removed the ID already.
          if (!isNonexistentScriptError(idErr)) {
            console.error(`[Bocchi Privacy Shield] Failed to unregister content script ${id}:`, idErr);
          }
        }
      }
    }
    return;
  }

  let existingIds = new Set();
  try {
    // Never assume "not registered" when the list query fails: the following
    // registerContentScripts() would then fail with duplicate IDs and every
    // bypass exclusion update would be lost.
    const existing = await withRetry('list content scripts',
      () => scripting.getRegisteredContentScripts());
    if (!Array.isArray(existing)) {
      console.error('[Bocchi Privacy Shield] Content-script list was not an array; keeping current registrations.');
      return;
    }
    existingIds = new Set(existing.map(s => s && s.id).filter(Boolean));
  } catch (err) {
    console.error('[Bocchi Privacy Shield] Failed to list content scripts after retry; keeping current registrations:', err);
    return;
  }

  const pending = CONTENT_SCRIPTS.map(spec => ({
    spec,
    definition: contentScriptDefinition(spec, excludeMatches)
  }));
  const updates = pending.filter(item => existingIds.has(item.spec.id));
  const registrations = pending.filter(item => !existingIds.has(item.spec.id));

  const reportFailure = (spec, fallbackErr) => {
    // Losing registration means no protection at all: surface it loudly.
    console.error(`[Bocchi Privacy Shield] Content script ${spec.id} registration failed:`, fallbackErr);
  };

  // Update all existing registrations in one call and register all missing
  // ones in another: Chrome rejects duplicate IDs, so mixing the two would
  // fail when only one script survived a previous partial sync.
  if (updates.length) {
    try {
      await scripting.updateContentScripts(updates.map(item => item.definition));
    } catch (err) {
      for (const item of updates) {
        try {
          await repairContentScript(item.spec, excludeMatches, true, err, scripting);
        } catch (fallbackErr) {
          reportFailure(item.spec, fallbackErr);
        }
      }
    }
  }
  if (registrations.length) {
    try {
      await scripting.registerContentScripts(registrations.map(item => item.definition));
    } catch (err) {
      for (const item of registrations) {
        try {
          await repairContentScript(item.spec, excludeMatches, false, err, scripting);
        } catch (fallbackErr) {
          reportFailure(item.spec, fallbackErr);
        }
      }
    }
  }
}

function syncContentScripts() {
  return enqueueContentScripts(syncContentScriptsNow);
}

/* ------------------------------------------------------------------ *
 * Alarm
 * ------------------------------------------------------------------ */

const TIMEZONE_ALARM = 'bocchi_tz_sync';

async function setupPeriodicTimezoneAlarm() {
  if (typeof chrome === 'undefined' || !chrome.alarms || typeof chrome.alarms.create !== 'function') return;
  try {
    // chrome.alarms.create() replaces an existing alarm of the same name and
    // resets its schedule. Every service-worker wake would otherwise postpone
    // the hourly refresh indefinitely, so only create it when missing.
    let existing = null;
    if (typeof chrome.alarms.get === 'function') {
      existing = await chrome.alarms.get(TIMEZONE_ALARM);
    }
    if (!existing) {
      await chrome.alarms.create(TIMEZONE_ALARM, { periodInMinutes: 60 });
    }
  } catch (err) {
    console.error('[Bocchi Privacy Shield] Failed to schedule timezone alarm:', err);
  }
}

/* ------------------------------------------------------------------ *
 * Accept-Language dynamic rule
 * ------------------------------------------------------------------ */

const LANGUAGE_RULE_ID = 9001;
const LANGUAGE_DEFAULT = 'en-US';

function normalizeLanguageTarget(value) {
  if (typeof value !== 'string') return LANGUAGE_DEFAULT;
  const target = value.trim();
  return /^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/.test(target) ? target : LANGUAGE_DEFAULT;
}

function languageList(target) {
  const base = target.split('-')[0];
  return base && base !== target ? [target, base] : [target];
}

function acceptLanguageValue(target) {
  return languageList(target).map((lang, i) => i === 0 ? lang : lang + ';q=' + (1 - i * 0.1).toFixed(1)).join(',');
}

async function applyLanguageHeaderNow() {
  const dnr = (typeof chrome !== 'undefined') ? chrome.declarativeNetRequest : null;
  if (!dnr || typeof dnr.getDynamicRules !== 'function' || typeof dnr.updateDynamicRules !== 'function') {
    return;
  }

  let res;
  try {
    res = await withRetry('read language config', () => chrome.storage.local.get([
      'globalShieldEnabled', 'languageProtection', 'languageHeader', 'languageTarget', 'siteBypassList'
    ]));
  } catch (err) {
    // The target state is unknown. Never silently keep a stale header rule:
    // leave a loud trace so the panel/support can see the failed reconcile.
    console.error('[Bocchi Privacy Shield] Failed to read language config after retry; dynamic rules left unchanged:', err);
    return;
  }
  res = res || {};
  const enabled = res.globalShieldEnabled !== false &&
    res.languageProtection === true &&
    res.languageHeader !== false;

  // Read the current rule only to avoid unnecessary updates. If the query
  // fails we still know the target state, and updateDynamicRules() ignores a
  // removeRuleIds entry that does not exist, so remove+add atomically below
  // cannot leave the old header behind.
  let removeRuleIds = [];
  try {
    const existing = await withRetry('list dynamic rules', () => dnr.getDynamicRules());
    if (Array.isArray(existing)) {
      removeRuleIds = existing.filter(r => r && r.id === LANGUAGE_RULE_ID).map(r => r.id);
    } else {
      console.error('[Bocchi Privacy Shield] Dynamic rules response was not an array; reconciling rule by id.');
      removeRuleIds = [LANGUAGE_RULE_ID];
    }
  } catch (err) {
    console.error('[Bocchi Privacy Shield] Failed to list dynamic rules after retry; reconciling rule by id:', err);
    removeRuleIds = [LANGUAGE_RULE_ID];
  }

  if (!enabled) {
    if (removeRuleIds.length) {
      try {
        await withRetry('remove Accept-Language rule', () => dnr.updateDynamicRules({ removeRuleIds }));
      } catch (err) {
        console.error('[Bocchi Privacy Shield] Failed to remove Accept-Language rule after retry:', err);
      }
    }
    return;
  }

  const target = normalizeLanguageTarget(res.languageTarget);
  const bypass = bypassDomains(res.siteBypassList);
  const condition = {
    urlFilter: '*',
    resourceTypes: ['main_frame', 'sub_frame', 'stylesheet', 'script', 'image', 'font', 'object', 'xmlhttprequest', 'ping', 'csp_report', 'media', 'websocket', 'other']
  };
  if (bypass.length) {
    condition.excludedRequestDomains = bypass;
    // Subresources requested by a bypassed page must not be rewritten
    // either, otherwise a bypassed site still sees a spoofed header on its
    // own XHR/fetch calls.
    condition.excludedInitiatorDomains = bypass;
  }
  const rule = {
    id: LANGUAGE_RULE_ID,
    priority: 2,
    action: {
      type: 'modifyHeaders',
      requestHeaders: [{ header: 'Accept-Language', operation: 'set', value: acceptLanguageValue(target) }]
    },
    condition
  };
  try {
    await withRetry('apply Accept-Language rule',
      () => dnr.updateDynamicRules({ removeRuleIds, addRules: [rule] }));
  } catch (err) {
    console.error('[Bocchi Privacy Shield] Failed to apply Accept-Language rule after retry:', err);
  }
}

function applyLanguageHeader() {
  // Serialize getDynamicRules -> updateDynamicRules: rapid language changes or
  // an init/storage race would otherwise both try to add rule 9001.
  return enqueueDnr(applyLanguageHeaderNow);
}

/* ------------------------------------------------------------------ *
 * Lifecycle
 * ------------------------------------------------------------------ */

function init() {
  applyWebRTCPolicy();
  applyLanguageHeader();
  syncStaticRuleset();
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
      if (alarm && alarm.name === TIMEZONE_ALARM) {
        syncTimezone(true);
      }
    });
  }

  if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.onChanged && chrome.storage.onChanged.addListener) {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local' || !changes) return;

      if (changes.globalShieldEnabled) {
        syncStaticRuleset();
      }
      if (changes.globalShieldEnabled || changes.webrtcProtection || changes.webrtcUdp || changes.webrtcLocalIp) {
        applyWebRTCPolicy();
      }
      if (changes.siteBypassList || changes.globalShieldEnabled) {
        syncContentScripts();
      }
      if (changes.globalShieldEnabled || changes.languageProtection || changes.languageHeader || changes.languageTarget || changes.siteBypassList) {
        applyLanguageHeader();
      }
      if (changes.globalShieldEnabled || changes.timezoneProtection) {
        const nowEnabled = changes.globalShieldEnabled
          ? changes.globalShieldEnabled.newValue !== false
          : true;
        const tzEnabled = changes.timezoneProtection
          ? changes.timezoneProtection.newValue !== false
          : true;
        if (nowEnabled && tzEnabled) {
          syncTimezone(false);
        }
      }
    });
  }

  if (chrome.runtime.onMessage) {
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
      if (message && message.type === 'GET_TIMEZONE') {
        (async () => {
          try {
            if (chrome.storage && chrome.storage.local) {
              const res = await chrome.storage.local.get(['timezone', 'ipLatitude', 'ipLongitude', 'ipCity']);
              // Do not hand the bridge a hardcoded fallback zone here: the
              // engine intentionally stays native until a real cached target
              // exists. Returning undefined makes the bridge keep native time.
              const tz = res && isValidTimezone(res.timezone) ? res.timezone.trim() : undefined;
              sendResponse({
                timezone: tz,
                ipLatitude: res && typeof res.ipLatitude === 'number' ? res.ipLatitude : undefined,
                ipLongitude: res && typeof res.ipLongitude === 'number' ? res.ipLongitude : undefined,
                ipCity: res && typeof res.ipCity === 'string' ? res.ipCity : undefined
              });
            } else {
              sendResponse({});
            }
          } catch (err) {
            console.error('[Bocchi Privacy Shield] Failed to read timezone cache:', err);
            sendResponse({});
          }
        })();
        return true;
      }
      if (message && message.type === 'SYNC_EGRESS') {
        syncTimezone(true)
          .then((tz) => sendResponse({ ok: true, timezone: tz }))
          .catch(() => sendResponse({ ok: false }));
        return true;
      }
    });
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    DEFAULT_TIMEZONE,
    applyWebRTCPolicy,
    applyLanguageHeader,
    normalizeLanguageTarget,
    acceptLanguageValue,
    normalizeBypassHost,
    bypassExcludeMatches,
    bypassDomains,
    isValidTimezone,
    fetchEgressInfo,
    fetchEgressTimezone,
    syncTimezone,
    syncContentScripts,
    syncStaticRuleset,
    setupPeriodicTimezoneAlarm
  };
}
