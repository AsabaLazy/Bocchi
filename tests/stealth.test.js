'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

console.log('=== Running Bocchi Privacy Shield Comprehensive Test Suite ===\n');

// 1. Test manifest.json
console.log('[Test 1] Validating manifest.json...');
const manifestPath = path.join(__dirname, '../manifest.json');
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

assert.strictEqual(manifest.manifest_version, 3, 'manifest_version must be 3');
assert(manifest.permissions.includes('declarativeNetRequest'), 'Must have declarativeNetRequest permission');
assert(manifest.permissions.includes('privacy'), 'Must have privacy permission');
assert(manifest.permissions.includes('storage'), 'Must have storage permission');
assert(manifest.host_permissions && manifest.host_permissions.includes('<all_urls>'), 'Must have <all_urls> host permission');
assert.strictEqual(manifest.background.service_worker, 'background/service_worker.js', 'Service worker path mismatch');
assert.strictEqual(manifest.declarative_net_request.rule_resources[0].path, 'rules/cyt_rules.json', 'DNR rules path mismatch');
assert(manifest.permissions.includes('scripting'), 'Must have scripting permission for dynamic content-script registration');
assert.strictEqual(manifest.content_scripts, undefined, 'Static content_scripts must be absent: injection is registered dynamically so bypassed sites receive NO injection');
const swSource = fs.readFileSync(path.join(__dirname, '../background/service_worker.js'), 'utf8');
assert(swSource.includes("id: 'bocchi-engine'") && swSource.includes("world: 'MAIN'"), 'SW must register the engine in the MAIN world');
assert(swSource.includes("id: 'bocchi-bridge'") && swSource.includes("world: 'ISOLATED'"), 'SW must register the bridge in the isolated world');
assert(swSource.includes('excludeMatches'), 'Dynamic registration must exclude bypassed hosts');
assert(swSource.includes("runAt: 'document_start'"), 'Dynamic scripts must run at document_start');
assert(swSource.includes('matchOriginAsFallback'), 'Dynamic scripts must fall back to initiator origin (about:blank frames)');
assert.strictEqual(manifest.web_accessible_resources, undefined, 'Must NOT declare web_accessible_resources (anti-fingerprinting)');
console.log('✓ manifest.json is fully valid and compliant.\n');

// 2. Test rules/cyt_rules.json
console.log('[Test 2] Validating rules/cyt_rules.json...');
const rulesPath = path.join(__dirname, '../rules/cyt_rules.json');
const rules = JSON.parse(fs.readFileSync(rulesPath, 'utf8'));

assert(Array.isArray(rules), 'cyt_rules.json must be an array');
assert(rules.length >= 4, 'Must have at least 4 rules');

// Rule 1: block trackersimulator.org
const rule1 = rules.find(r => r.condition.urlFilter === '||trackersimulator.org');
assert(rule1 && rule1.action.type === 'block', 'Rule 1 must block trackersimulator.org');

// Rule 2: block eviltracker.net
const rule2 = rules.find(r => r.condition.urlFilter === '||eviltracker.net');
assert(rule2 && rule2.action.type === 'block', 'Rule 2 must block eviltracker.net');

// Rule 3: allow do-not-tracker.org with higher priority
const rule3 = rules.find(r => r.condition.urlFilter === '||do-not-tracker.org');
assert(rule3 && rule3.action.type === 'allow' && rule3.priority > rule1.priority, 'Rule 3 must allow do-not-tracker.org with higher priority');

// Rule 4: modifyHeaders owns ONLY the static, non-persona headers
// (DNT, Sec-GPC). User-Agent / Accept-Language and every Sec-CH-* client hint
// are gone: personas were removed entirely (native passthrough), so no
// UA-related header is rewritten anymore.
const rule4 = rules.find(r => r.action.type === 'modifyHeaders');
assert(rule4, 'Must have modifyHeaders rule');
const dntHeader = rule4.action.requestHeaders.find(h => h.header === 'DNT');
const gpcHeader = rule4.action.requestHeaders.find(h => h.header === 'Sec-GPC');
assert(dntHeader && dntHeader.value === '1', 'DNT header must be set to 1');
assert(gpcHeader && gpcHeader.value === '1', 'Sec-GPC header must be set to 1');
const rule4Headers = rule4.action.requestHeaders.map(h => h.header);
assert.strictEqual(rule4Headers.length, 2, 'Static modifyHeaders rule must contain exactly the 2 static headers');
assert(!rule4Headers.includes('Accept-Language'), 'Accept-Language must NOT be set statically (language is passed through natively)');
assert(!rule4Headers.includes('User-Agent'), 'User-Agent must NOT be in static rules (native passthrough)');
assert(!rule4Headers.some(h => h.startsWith('Sec-CH-')), 'All Sec-CH-* client hint headers must be removed from static rules');
console.log('✓ rules/cyt_rules.json is fully valid and compliant.\n');

// 3. Test background/service_worker.js
console.log('[Test 3] Validating background/service_worker.js...');
const swPath = path.join(__dirname, '../background/service_worker.js');
const swCode = fs.readFileSync(swPath, 'utf8');

let policySet = null;
let storageData = {};
let mockFetchReturn = null;
let mockFetchError = false;
const installedListeners = [];
const startupListeners = [];

const mockChrome = {
  privacy: {
    network: {
      webRTCIPHandlingPolicy: {
        set(obj, cb) {
          policySet = obj.value;
          if (cb) cb();
          return Promise.resolve();
        }
      }
    }
  },
  storage: {
    local: {
      get(keys, cb) {
        if (cb) { cb(storageData); return; }
        return Promise.resolve(storageData);
      },
      set(obj, cb) {
        Object.assign(storageData, obj);
        if (cb) { cb(); return; }
        return Promise.resolve();
      }
    }
  },
  runtime: {
    lastError: null,
    onInstalled: { addListener(fn) { installedListeners.push(fn); } },
    onStartup: { addListener(fn) { startupListeners.push(fn); } },
    onMessage: { addListener(fn) {} }
  }
};

let mockFetchHandler = null;
const mockFetch = async function(url) {
  if (mockFetchError) {
    throw new Error('Network error');
  }
  if (mockFetchHandler) {
    return mockFetchHandler(url);
  }
  return {
    ok: true,
    json: async () => mockFetchReturn || { timezone: { id: 'America/Los_Angeles' } }
  };
};

const swModule = { exports: {} };
const swContext = vm.createContext({
  chrome: mockChrome,
  console: console,
  fetch: mockFetch,
  crypto: { randomUUID: () => 'sw-test-session-key-uuid' },
  module: swModule,
  exports: swModule.exports
});
vm.runInContext(swCode, swContext);

assert.strictEqual(installedListeners.length, 1, 'Service worker must register onInstalled listener');
assert.strictEqual(startupListeners.length, 1, 'Service worker must register onStartup listener');

(async () => {
  // applyWebRTCPolicy now always reads chrome.storage.local through a Promise
  // (the old synchronous callback shortcut was dead code and was removed), so
  // the policy write lands in a microtask; flush the queue before asserting.
  await new Promise(resolve => setImmediate(resolve));

  assert.strictEqual(policySet, 'disable_non_proxied_udp', 'Service worker must set webRTCIPHandlingPolicy to disable_non_proxied_udp');

  const { fetchEgressInfo, fetchEgressTimezone, syncTimezone } = swModule.exports;
  assert(typeof fetchEgressInfo === 'function', 'fetchEgressInfo must be a function');
  assert(typeof fetchEgressTimezone === 'function', 'fetchEgressTimezone must be a function');
  assert(typeof syncTimezone === 'function', 'syncTimezone must be a function');

  // Successful GeoIP fetch (timezone + IP coordinates)
  mockFetchError = false;
  mockFetchReturn = { timezone: { id: 'America/Chicago' }, latitude: 41.85, longitude: -87.65, city: 'Chicago' };
  const detectedTz = await fetchEgressTimezone();
  assert.strictEqual(detectedTz, 'America/Chicago', 'fetchEgressTimezone should return detected timezone');
  const detectedInfo = await fetchEgressInfo();
  assert.strictEqual(detectedInfo.timezone, 'America/Chicago', 'fetchEgressInfo should carry the timezone');
  assert.strictEqual(detectedInfo.lat, 41.85, 'fetchEgressInfo should carry the latitude');
  assert.strictEqual(detectedInfo.lng, -87.65, 'fetchEgressInfo should carry the longitude');
  assert.strictEqual(detectedInfo.city, 'Chicago', 'fetchEgressInfo should carry the city');

  // Fallback to geojs.io when ipwho.is fails
  mockFetchError = false;
  mockFetchHandler = async (url) => {
    if (url.includes('ipwho.is')) throw new Error('ipwho failed');
    if (url.includes('geojs.io')) return { ok: true, json: async () => ({ timezone: 'America/Phoenix' }) };
    return { ok: true, json: async () => ({ timezone: 'America/Los_Angeles' }) };
  };
  const geojsTz = await fetchEgressTimezone();
  assert.strictEqual(geojsTz, 'America/Phoenix', 'fetchEgressTimezone should fallback to geojs.io when ipwho.is fails');
  mockFetchHandler = null;

  // Fallback on all network errors
  mockFetchError = true;
  const fallbackTz = await fetchEgressTimezone();
  assert.strictEqual(fallbackTz, 'America/Los_Angeles', 'fetchEgressTimezone should fallback to America/Los_Angeles on error');

  // syncTimezone stores the timezone and the IP location
  mockFetchError = false;
  mockFetchReturn = { timezone: { id: 'America/Denver' }, latitude: 39.74, longitude: -104.99, city: 'Denver' };
  await syncTimezone();
  assert.strictEqual(storageData.timezone, 'America/Denver', 'syncTimezone should store the timezone');
  assert.strictEqual(storageData.ipLatitude, 39.74, 'syncTimezone should store the IP latitude');
  assert.strictEqual(storageData.ipLongitude, -104.99, 'syncTimezone should store the IP longitude');
  assert.strictEqual(storageData.ipCity, 'Denver', 'syncTimezone should store the IP city');

  // Persona machinery was removed entirely: the service worker must NOT
  // export syncUserAgentRule and must not touch declarativeNetRequest.
  assert.strictEqual(swModule.exports.syncUserAgentRule, undefined, 'syncUserAgentRule must no longer be exported (no UA persona)');

  console.log('✓ background/service_worker.js fully valid (policy, timezone, alarms).');
})();

// Test content/bridge.js isolated world bridge
console.log('Validating content/bridge.js isolated world bridge...');
const bridgePath = path.join(__dirname, '../content/bridge.js');
const bridgeCode = fs.readFileSync(bridgePath, 'utf8');

// Bridge storage mock with per-key data so both the full initial read
// (ALL_KEYS) and the incremental font/shield reads observe their values.
const bridgeStorageData = {
  targetTimezone: 'America/New_York',
  customHiddenFonts: [],
  customAllowedFonts: [],
  blockBuiltinChineseFonts: true,
  fontMode: 'blacklist',
  blockOtherScripts: false,
  fontProtection: true,
  globalShieldEnabled: true,
  siteBypassList: ['https://figma.com'],
  canvasProtection: true,
  webrtcProtection: true,
  audioProtection: true,
  timezoneProtection: true,
  hardwareProtection: true
};
const dispatchedBridgeEvents = [];
let bridgeStorageChangedListener = null;
const bridgeDocListeners = {};
const bridgeMockChrome = {
  storage: {
    local: {
      get(keys, cb) {
        const res = {};
        (Array.isArray(keys) ? keys : [keys]).forEach(k => {
          if (k in bridgeStorageData) res[k] = bridgeStorageData[k];
        });
        cb(res);
      }
    },
    onChanged: {
      addListener(fn) {
        bridgeStorageChangedListener = fn;
      }
    }
  }
};
let bridgePostMessageCalled = false;
const bridgeMockDoc = {
  addEventListener(type, fn) {
    (bridgeDocListeners[type] = bridgeDocListeners[type] || []).push(fn);
  },
  dispatchEvent(evt) {
    dispatchedBridgeEvents.push(evt);
    // Deliver handshake events to registered listeners (simulates the MAIN
    // world engine re-announcing after the bridge's '__bocchi_req__').
    if (evt.type === '__bocchi_hs__' && bridgeDocListeners[evt.type]) {
      for (const fn of bridgeDocListeners[evt.type].slice()) fn(evt);
    }
    return true;
  }
};
const bridgeMockWin = {
  chrome: bridgeMockChrome,
  document: bridgeMockDoc,
  CustomEvent: class CustomEvent {
    constructor(type, init) {
      this.type = type;
      this.detail = init ? init.detail : {};
    }
  },
  postMessage() {
    bridgePostMessageCalled = true;
  }
};
bridgeMockWin.window = bridgeMockWin;
vm.runInContext(bridgeCode, vm.createContext(bridgeMockWin));

// Bridge bootstrap: asks the (already loaded) engine to re-send its handshake.
const reqEvt = dispatchedBridgeEvents.find(e => e.type === '__bocchi_req__');
assert(reqEvt, 'bridge.js must dispatch __bocchi_req__ at load to request the engine handshake');
assert(bridgeDocListeners['__bocchi_hs__'] && bridgeDocListeners['__bocchi_hs__'].length === 1,
  'bridge.js must register exactly one __bocchi_hs__ listener at load');

// Before any handshake arrives, the bridge must stay silent: the engine no
// longer listens on the legacy fixed event names, so dispatching there would
// only broadcast into the void. Payloads are dropped until the handshake.
assert(!dispatchedBridgeEvents.some(e =>
  e.type === '__bocchi_tz_sync__' || e.type === '__bocchi_fonts_sync__' || e.type === '__bocchi_config_sync__'),
  'bridge.js must never fall back to the removed legacy fixed event names');
assert.strictEqual(dispatchedBridgeEvents.filter(e => e.type !== '__bocchi_req__').length, 0,
  'bridge.js must not dispatch any config payload before the handshake (no handshake -> payload dropped)');
assert.strictEqual(bridgePostMessageCalled, false, 'bridge.js must never call postMessage');

// Handshake arrives (engine re-announces): the bridge locks {t, CE} and pushes
// a full tz+fonts+cfg payload over the secured channel.
const BRIDGE_TOKEN = '0123456789abcdef0123456789abcdef';
const BRIDGE_CE = '__bocchi_evt_deadbeef';
bridgeMockDoc.dispatchEvent({ type: '__bocchi_hs__', detail: { t: BRIDGE_TOKEN, e: BRIDGE_CE } });
const fullEvt = dispatchedBridgeEvents.filter(e => e.type === BRIDGE_CE).pop();
assert(fullEvt, 'after handshake the bridge must send the full config payload on CE');
assert.strictEqual(fullEvt.detail.t, BRIDGE_TOKEN, 'CE payload must carry the handshake token t');
assert.strictEqual(fullEvt.detail.tz, 'America/New_York', 'CE payload must carry the timezone');
assert.strictEqual(fullEvt.detail.fonts.blockBuiltin, true, 'CE payload must carry the fonts config');
assert.strictEqual(fullEvt.detail.cfg.globalShieldEnabled, true, 'CE payload must carry the shield config');
assert.strictEqual(fullEvt.detail.cfg.siteBypassList[0], 'https://figma.com', 'CE payload must forward siteBypassList');

// A second (possibly forged) handshake must be ignored: first handshake wins.
bridgeMockDoc.dispatchEvent({ type: '__bocchi_hs__', detail: { t: 'attacker-token', e: '__bocchi_evt_evil' } });
assert(!dispatchedBridgeEvents.some(e => e.type === '__bocchi_evt_evil'),
  'bridge must ignore handshakes after the first valid one (channel hijack prevention)');

if (bridgeStorageChangedListener) {
  // Incremental local storage updates are grouped: tz-only change -> {tz} payload.
  bridgeStorageData.targetTimezone = 'Asia/Tokyo';
  bridgeStorageChangedListener({ targetTimezone: { newValue: 'Asia/Tokyo' } }, 'local');
  const latestTz = dispatchedBridgeEvents[dispatchedBridgeEvents.length - 1];
  assert.strictEqual(latestTz.type, BRIDGE_CE, 'tz storage change must be sent over CE');
  assert.strictEqual(latestTz.detail.tz, 'Asia/Tokyo');
  assert.strictEqual(latestTz.detail.t, BRIDGE_TOKEN, 'incremental tz payload must keep the token');

  // Geo-follow mode: the zone comes from geoTimezone, not the egress IP.
  bridgeStorageData.timezoneMode = 'geo';
  bridgeStorageData.geolocationProtection = true;
  bridgeStorageData.geoTimezone = 'Europe/Berlin';
  bridgeStorageChangedListener({ timezoneMode: { newValue: 'geo' } }, 'local');
  const latestGeo = dispatchedBridgeEvents[dispatchedBridgeEvents.length - 1];
  assert.strictEqual(latestGeo.detail.tz, 'Europe/Berlin',
    'geo mode must use the zone derived from the spoofed coordinates');
  assert.strictEqual(latestGeo.detail.t, BRIDGE_TOKEN, 'geo tz payload must keep the token');

  // With the location module off, follow mode must fall back to the IP cache
  // exactly like the panel readout does.
  bridgeStorageData.geolocationProtection = false;
  bridgeStorageChangedListener({ geolocationProtection: { newValue: false } }, 'local');
  // The same change also emits a geo payload, so pick the latest tz payload.
  const latestGeoOff = dispatchedBridgeEvents.filter(e => e.detail && typeof e.detail.tz === 'string').pop();
  assert.strictEqual(latestGeoOff.detail.tz, 'Asia/Tokyo',
    'geo mode with the location module off must fall back to the IP cache');
  bridgeStorageData.geolocationProtection = true;

  // Geo mode without a derived zone yet falls back to the egress-IP cache.
  delete bridgeStorageData.geoTimezone;
  bridgeStorageData.geolocationProtection = true;
  bridgeStorageChangedListener({ geoTimezone: { newValue: undefined } }, 'local');
  const latestGeoFallback = dispatchedBridgeEvents[dispatchedBridgeEvents.length - 1];
  assert.strictEqual(latestGeoFallback.detail.tz, 'Asia/Tokyo',
    'geo mode must fall back to the IP cache until the panel derives a zone');

  // Restore auto mode for the remaining bridge assertions.
  bridgeStorageData.timezoneMode = 'auto';
  bridgeStorageData.targetTimezone = 'America/New_York';
  bridgeStorageChangedListener({ timezoneMode: { newValue: 'auto' } }, 'local');

  // Font keys -> incremental {fonts} payload (reads back the new list from storage).
  bridgeStorageData.customHiddenFonts = ['CustomFont'];
  bridgeStorageChangedListener({ customHiddenFonts: { newValue: ['CustomFont'] } }, 'local');
  const latestFont = dispatchedBridgeEvents[dispatchedBridgeEvents.length - 1];
  assert.strictEqual(latestFont.type, BRIDGE_CE, 'font storage change must be sent over CE');
  assert.strictEqual(latestFont.detail.fonts.customFonts[0], 'CustomFont');

  // Shield keys -> incremental {cfg} payload.
  bridgeStorageData.globalShieldEnabled = false;
  bridgeStorageChangedListener({ globalShieldEnabled: { newValue: false } }, 'local');
  const latestCfg = dispatchedBridgeEvents[dispatchedBridgeEvents.length - 1];
  assert.strictEqual(latestCfg.type, BRIDGE_CE, 'shield storage change must be sent over CE');
  assert.strictEqual(latestCfg.detail.cfg.globalShieldEnabled, false);

  // Session keys were removed with the persona machinery: rotating a stale
  // legacy key must NOT trigger any new CE payload.
  const beforeCount = dispatchedBridgeEvents.length;
  bridgeStorageChangedListener({ bocchiSessionKey: { newValue: 'session-key-42' } }, 'session');
  assert.strictEqual(dispatchedBridgeEvents.length, beforeCount, 'legacy session key changes must not trigger a CE payload (k removed)');
}
assert.strictEqual(bridgePostMessageCalled, false, 'bridge.js must never call postMessage on storage update');
console.log('✓ content/bridge.js handshake-secured channel (protocol v2) verified.\n');

// 4. Test content/stealth_engine.js in simulated browser context
console.log('[Test 4] Validating content/stealth_engine.js in simulated browser context...');
const stealthCode = fs.readFileSync(path.join(__dirname, '../content/stealth_engine.js'), 'utf8');

// 32-bit djb2 hash (mirrors the engine's implementation).
function djb2Hash(str) {
  let hash = 5381;
  for (let i = 0; i < str.length; i++) hash = ((hash << 5) + hash) + str.charCodeAt(i);
  return hash >>> 0;
}
// Session salt pinned by the mock crypto stub above (see createMockWindow).
const TEST_SESSION_SALT = 305419896;
// Engine farbling formulas, replicated so expected values are computed, not guessed:
//   canvasDelta = (djb2(host:salt:canvas) % 12) * 2 + 1  -> r = perturbPixel(100, delta)
//   webglDelta  = (djb2(host:salt:webgl)  % 12) * 2 + 1  -> pixel[idx] perturbed, idx = djb2 % 4
//   audioDelta  = ((djb2(host:salt:audio) % 50) * 2 + 1) * 1e-7
function perturbPixelRef(val, delta) {
  const step = (Math.abs(delta) % 25) + 1;
  return val >= 255 - step ? val - step : val + step;
}
function expectedFarbledCanvasUrl(host) {
  const delta = (djb2Hash(host + ':' + TEST_SESSION_SALT + ':canvas') % 12) * 2 + 1;
  return 'data:image/png;base64,mockPngR' + perturbPixelRef(100, delta) + 'A255';
}
function expectedFarbledWebglPixels(host) {
  const seed = djb2Hash(host + ':' + TEST_SESSION_SALT + ':webgl');
  const delta = (seed % 12) * 2 + 1;
  const px = [50, 60, 70, 255];
  const idx = seed % Math.min(px.length, 4);
  px[idx] = perturbPixelRef(px[idx], delta);
  return px;
}
function expectedAudioDelta(host) {
  return ((djb2Hash(host + ':' + TEST_SESSION_SALT + ':audio') % 50) * 2 + 1) * 1e-7;
}
// GPU persona pool (mirrors the engine's GPU_PROFILES): renderer + the Dawn
// architecture spelling paired with it. Selection is
// GPU_PROFILES[djb2(eTLD+1(host)) % 5]: keyed on the site's registrable-domain
// approximation (last two host labels) with NO salt, so every frame of one site
// — each frame hashes independently — reports the same renderer, and the
// persona is stable across reloads/sessions.
const GPU_PROFILES_REF = [
  { renderer: 'Mesa Intel(R) UHD Graphics (CML GT2)', wgpuArch: 'gen-9' },
  { renderer: 'Mesa Intel(R) Iris(R) Xe Graphics (TGL GT2)', wgpuArch: 'gen-12lp' },
  { renderer: 'Mesa Intel(R) UHD Graphics 620 (KBL GT2)', wgpuArch: 'gen-9' },
  { renderer: 'Mesa Intel(R) HD Graphics 530 (SKL GT2)', wgpuArch: 'gen-9' },
  { renderer: 'Mesa Intel(R) Iris(R) Plus Graphics (ICL GT2)', wgpuArch: 'gen-11' }
];
// eTLD+1 approximation used by the engine's GPU profile selection.
function etld1(host) {
  return String(host).split('.').slice(-2).join('.');
}
function expectedGpuProfile(host) {
  return GPU_PROFILES_REF[djb2Hash(etld1(host)) % GPU_PROFILES_REF.length];
}

function createMockWindow(hostname, platform = 'Linux x86_64') {
  const win = {};

  // Builtin globals
  win.Function = Function;
  // Per-window Date: sharing the host Date across mock windows (and with the
  // test file itself) lets every engine instance chain its prototype hooks
  // onto the same object — the outermost instance's activeTimezone silently
  // wins, which both masks cross-realm bugs and makes results host-TZ
  // dependent. Real realms each have their own Date intrinsics, so expose an
  // isolated subclass with a fresh prototype (statics delegate to the host).
  class WDate extends Date {}
  // Statics are tz-neutral (UTC-based) and never hooked by the engine, so the
  // host function objects can be shared directly — keeping their native
  // toString — while the fresh WDate.prototype prevents hook chaining.
  ['now', 'parse', 'UTC'].forEach(m => {
    WDate[m] = Date[m];
  });
  win.Date = WDate;
  // Per-window Intl: real realms each have their own Intl intrinsics. Sharing
  // the host Intl object across mock windows would let every engine instance
  // chain its prototype hooks (DateTimeFormat/resolvedOptions etc.) onto the
  // previous instance's hooks, so expose isolated wrapper classes with fresh
  // prototypes that inherit from the pristine host constructors.
  function makeIsolatedIntlCtor(name) {
    const Orig = Intl[name];
    function IsolatedCtor(locales, options) {
      if (new.target) return Reflect.construct(Orig, [locales, options], new.target);
      return Orig(locales, options);
    }
    IsolatedCtor.prototype = Object.create(Orig.prototype);
    if (Orig.supportedLocalesOf) IsolatedCtor.supportedLocalesOf = Orig.supportedLocalesOf;
    return IsolatedCtor;
  }
  win.Intl = {};
  ['DateTimeFormat', 'NumberFormat', 'PluralRules', 'RelativeTimeFormat', 'Collator', 'ListFormat', 'DisplayNames', 'Segmenter'].forEach(name => {
    if (typeof Intl[name] === 'function') win.Intl[name] = makeIsolatedIntlCtor(name);
  });
  // Array is exposed like a real realm so prototype-level hooks (e.g. the
  // removed Array.prototype.includes backdoor) would be observable in tests.
  win.Array = Array;

  // CustomEvent: the engine announces its protocol-v2 handshake
  // ('__bocchi_hs__' with {t, e}) by constructing a CustomEvent on document.
  win.CustomEvent = class CustomEvent {
    constructor(type, init) {
      this.type = type;
      this.detail = init ? init.detail : null;
    }
  };

  // Deterministic crypto.getRandomValues: pins the engine's per-load session
  // salt (GLOBAL_SESSION_SALT) to a fixed value, so farbling deltas are
  // reproducible. Cross-domain divergence assertions below compute the exact
  // expected values from the same djb2 formulas instead of gambling on the
  // ~1/12 salt-collision flake of random salts.
  win.crypto = {
    getRandomValues(arr) {
      for (let i = 0; i < arr.length; i++) {
        arr[i] = (TEST_SESSION_SALT + i * 2654435761) >>> 0;
      }
      return arr;
    }
  };

  // Window references
  win.window = win;
  win.top = win;
  win.location = { hostname: hostname };
  class FontFace {
    constructor(family, source, descriptors) {
      this.family = family;
      this.source = source;
      this.status = 'unloaded';
    }
    load() {
      this.status = 'loaded';
      return Promise.resolve(this);
    }
  }
  win.FontFace = FontFace;
  win.DOMException = globalThis.DOMException || class DOMException extends Error {
    constructor(msg, name) {
      super(msg);
      this.name = name || 'DOMException';
    }
  };

  class FontFaceSet {
    check(font, text) {
      return true;
    }
    load(font, text) {
      return Promise.resolve([{ family: font }]);
    }
  }
  win.FontFaceSet = FontFaceSet;
  win.document = {
    referrer: '',
    createElement(tag) {
      if (tag === 'canvas') return new win.HTMLCanvasElement();
      if (tag === 'iframe') return new win.HTMLIFrameElement();
      return { tagName: tag.toUpperCase() };
    },
    fonts: new FontFaceSet()
  };

  win.queryLocalFonts = function() {
    return Promise.resolve([
      { family: 'Arial', fullName: 'Arial Regular', postscriptName: 'ArialMT' },
      { family: 'SimSun', fullName: 'SimSun Regular', postscriptName: 'SimSun' },
      { family: 'Microsoft YaHei', fullName: 'Microsoft YaHei', postscriptName: 'MicrosoftYaHei' },
      { family: 'Times New Roman', fullName: 'Times New Roman', postscriptName: 'TimesNewRomanPSMT' }
    ]);
  };

  // CSSStyleDeclaration and getComputedStyle
  class CSSStyleDeclaration {
    constructor() {
      this._props = {};
    }
    getPropertyValue(prop) {
      return this._props[prop] || '';
    }
    setProperty(prop, val) {
      this._props[prop] = val;
    }
    get fontFamily() {
      return this.getPropertyValue('font-family');
    }
    set fontFamily(v) {
      this.setProperty('font-family', v);
    }
    get font() {
      return this.getPropertyValue('font');
    }
    set font(v) {
      this.setProperty('font', v);
    }
  }
  win.CSSStyleDeclaration = CSSStyleDeclaration;

  win.getComputedStyle = function(el) {
    const s = new CSSStyleDeclaration();
    const ff = (el && el._computedFontFamily) || (el && el.style && el.style.fontFamily) || 'sans-serif';
    s.setProperty('font-family', ff);
    return s;
  };

  // Event listeners on window and document
  const winListeners = {};
  win.addEventListener = function(type, fn, opts) {
    if (!winListeners[type]) winListeners[type] = [];
    winListeners[type].push(fn);
  };
  win.removeEventListener = function(type, fn) {
    if (winListeners[type]) winListeners[type] = winListeners[type].filter(f => f !== fn);
  };
  win.dispatchEvent = function(event) {
    if (winListeners[event.type]) {
      for (const fn of winListeners[event.type]) fn.call(win, event);
    }
  };
  win.postMessage = function(data, origin) {
    win.dispatchEvent({ type: 'message', data, source: win, origin: '*' });
  };

  win.speechSynthesis = {
    getVoices: () => []
  };
  win.SpeechSynthesisVoice = function() {};

  // Document events are recorded so tests can capture the engine's load-time
  // '__bocchi_hs__' handshake (token T + random config event name CE) and then
  // drive authenticated config payloads through driveConfig().
  win._dispatchedDocEvents = [];
  const docListeners = {};
  win.document.addEventListener = function(type, fn, opts) {
    if (!docListeners[type]) docListeners[type] = [];
    docListeners[type].push(fn);
  };
  win.document.removeEventListener = function(type, fn) {
    if (docListeners[type]) docListeners[type] = docListeners[type].filter(f => f !== fn);
  };
  win.document.dispatchEvent = function(event) {
    win._dispatchedDocEvents.push(event);
    if (docListeners[event.type]) {
      for (const fn of docListeners[event.type]) fn.call(win.document, event);
    }
  };

  // DOMRect
  class DOMRect {
    constructor(x = 0, y = 0, width = 0, height = 0) {
      this.x = x;
      this.y = y;
      this.width = width;
      this.height = height;
      this.top = y;
      this.left = x;
      this.right = x + width;
      this.bottom = y + height;
    }
  }
  win.DOMRect = DOMRect;

  // DOM Elements
  class Node {
    appendChild(child) {
      return child;
    }
    insertBefore(child, ref) {
      return child;
    }
  }
  win.Node = Node;

  class Element extends Node {
    constructor() {
      super();
      // Real DOM elements are nodeType 1; the engine's inline-declaration
      // precheck (needsFontMasking) relies on this to classify elements.
      this.nodeType = 1;
      this.parentElement = null;
    }
    getBoundingClientRect() {
      let w = 100;
      const ff = (this.style && (this.style.fontFamily || this.style.font)) || this._computedFontFamily;
      if (ff && (ff.includes('SimSun') || ff.includes('SimHei'))) {
        w = 180; // Extended width under SimSun
      }
      return new win.DOMRect(10, 20, w, 50);
    }
    getClientRects() {
      return [this.getBoundingClientRect()];
    }
  }
  win.Element = Element;

  class HTMLElement extends Element {
    constructor() {
      super();
      this._offsetWidth = 150.33;
      this._offsetHeight = 75.88;
      this.style = {
        fontFamily: '',
        font: ''
      };
      this._computedFontFamily = '';
    }
  }
  Object.defineProperty(HTMLElement.prototype, 'offsetWidth', {
    get() {
      const ff = (this.style && this.style.fontFamily) || this._computedFontFamily;
      if (ff && (ff.includes('SimSun') || ff.includes('SimHei'))) {
        return 220; // Chinese font dimension
      }
      return this._offsetWidth || 150;
    },
    configurable: true,
    enumerable: true
  });
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
    get() {
      const ff = (this.style && this.style.fontFamily) || this._computedFontFamily;
      if (ff && (ff.includes('SimSun') || ff.includes('SimHei'))) {
        return 110; // Chinese font dimension
      }
      return this._offsetHeight || 75;
    },
    configurable: true,
    enumerable: true
  });
  win.HTMLElement = HTMLElement;

  class HTMLIFrameElement extends HTMLElement {
    constructor() {
      super();
      this.tagName = 'IFRAME';
      this._contentWindow = createMockWindow('about:blank', platform);
      this._contentWindow.top = win;
    }
    get contentWindow() {
      return this._contentWindow;
    }
    get contentDocument() {
      return this._contentWindow.document;
    }
  }
  win.HTMLIFrameElement = HTMLIFrameElement;
  win.HTMLFrameElement = HTMLIFrameElement;

  // Blob & URL mock
  win.Blob = class Blob {
    constructor(parts, options) {
      this.parts = parts;
      this.options = options;
      this.content = parts.join('');
    }
  };

  class MockURL {
    constructor(url, base) {
      this.href = (base && !url.startsWith('http') && !url.startsWith('blob:')) ? (base + '/' + url) : url;
    }
    static createObjectURL(blob) {
      const id = 'blob:http://' + (hostname || 'example.com') + '/' + Math.random().toString(36).slice(2);
      MockURL._created = MockURL._created || new Map();
      MockURL._created.set(id, blob);
      return id;
    }
  }
  win.URL = MockURL;

  // Range
  class Range {
    constructor() {
      this.commonAncestorContainer = null;
      this.startContainer = null;
      this.startOffset = 0;
      this.endContainer = null;
      this.endOffset = 0;
    }
    selectNode(node) {
      this.startContainer = node.parentElement || node;
      this.commonAncestorContainer = node.parentElement || node;
      this.startOffset = 0;
      if (node.parentElement && !node.parentElement.childNodes) {
        node.parentElement.childNodes = [node];
      }
    }
    selectNodeContents(node) {
      this.commonAncestorContainer = node;
      this.startContainer = node;
      this.startOffset = 0;
    }
    getBoundingClientRect() {
      let node = this.commonAncestorContainer || this.startContainer;
      while (node && node.nodeType !== 1) node = node.parentElement;
      const ff = (node && node.style && (node.style.fontFamily || node.style.font)) || (node && node._computedFontFamily);
      const w = (ff && (ff.includes('SimSun') || ff.includes('SimHei'))) ? 180 : 100;
      return new win.DOMRect(0, 0, w, 20);
    }
    getClientRects() {
      return [this.getBoundingClientRect()];
    }
  }
  win.Range = Range;
  win.document.createRange = () => new Range();

  // SVG Elements
  class SVGElement extends Element {
    constructor() {
      super();
      this._attrs = {};
      this.style = { fontFamily: '', font: '' };
    }
    getAttribute(name) {
      return this._attrs[name] !== undefined ? this._attrs[name] : null;
    }
    setAttribute(name, val) {
      this._attrs[name] = String(val);
    }
    hasAttribute(name) {
      return this._attrs[name] !== undefined;
    }
  }
  win.SVGElement = SVGElement;

  class SVGGraphicsElement extends SVGElement {
    getBBox() {
      const ff = this.getAttribute('font-family') || (this.style && this.style.fontFamily);
      const w = (ff && (ff.includes('SimSun') || ff.includes('SimHei'))) ? 180 : 100;
      return new win.DOMRect(0, 0, w, 20);
    }
  }
  win.SVGGraphicsElement = SVGGraphicsElement;

  class SVGTextContentElement extends SVGGraphicsElement {
    getComputedTextLength() {
      const ff = this.getAttribute('font-family') || (this.style && this.style.fontFamily);
      return (ff && (ff.includes('SimSun') || ff.includes('SimHei'))) ? 180 : 100;
    }
    getSubStringLength() {
      return this.getComputedTextLength();
    }
    getExtentOfChar() {
      return new win.DOMRect(0, 0, 10, 10);
    }
  }
  win.SVGTextContentElement = SVGTextContentElement;

  // Worker & SharedWorker
  class RealWorker {
    constructor(scriptURL, options) {
      if (arguments.length === 0) {
        throw new TypeError("Failed to construct 'Worker': 1 argument required, but only 0 present.");
      }
      this.scriptURL = scriptURL;
      this.options = options;
      this._listeners = {};
      RealWorker.lastInstance = this;
    }
    addEventListener(type, fn) {
      this._listeners[type] = this._listeners[type] || [];
      this._listeners[type].push(fn);
    }
    removeEventListener(type, fn) {
      if (this._listeners[type]) {
        this._listeners[type] = this._listeners[type].filter(f => f !== fn);
      }
    }
    dispatchEvent(ev) {
      if (this._listeners[ev.type]) {
        for (const fn of this._listeners[ev.type]) fn.call(this, ev);
      }
      if (this['on' + ev.type]) {
        this['on' + ev.type].call(this, ev);
      }
    }
    postMessage(msg) {}
    terminate() {}
  }
  win.Worker = RealWorker;

  class RealSharedWorker {
    constructor(scriptURL, options) {
      if (arguments.length === 0) {
        throw new TypeError("Failed to construct 'SharedWorker': 1 argument required, but only 0 present.");
      }
      this.scriptURL = scriptURL;
      this.options = options;
      this.port = {
        _listeners: {},
        addEventListener(type, fn) {
          this._listeners[type] = this._listeners[type] || [];
          this._listeners[type].push(fn);
        },
        removeEventListener(type, fn) {
          if (this._listeners[type]) {
            this._listeners[type] = this._listeners[type].filter(f => f !== fn);
          }
        },
        dispatchEvent(ev) {
          if (this._listeners[ev.type]) {
            for (const fn of this._listeners[ev.type]) fn.call(this, ev);
          }
          if (this['on' + ev.type]) {
            this['on' + ev.type].call(this, ev);
          }
        },
        postMessage() {}
      };
      RealSharedWorker.lastInstance = this;
    }
  }
  win.SharedWorker = RealSharedWorker;

  // Canvas Classes
  class CanvasRenderingContext2D {
    constructor(canvas) {
      this.canvas = canvas;
      this.font = '10px sans-serif';
      this._pixels = new Uint8ClampedArray(4 * 10 * 10);
      for (let i = 0; i < this._pixels.length; i += 4) {
        this._pixels[i] = 100;     // R
        this._pixels[i + 1] = 150; // G
        this._pixels[i + 2] = 200; // B
        this._pixels[i + 3] = 255; // A
      }
    }
    getImageData(sx, sy, sw, sh) {
      return { data: new Uint8ClampedArray(this._pixels.slice(0, sw * sh * 4)) };
    }
    putImageData(imgData, dx, dy) {
      for (let i = 0; i < imgData.data.length; i++) {
        this._pixels[i] = imgData.data[i];
      }
    }
    drawImage() {}
    measureText(text) {
      const font = this.font || '10px sans-serif';
      let width = (text ? text.length : 0) * 10;
      if (font.includes('SimSun') || font.includes('SimHei')) {
        width += 70; // Chinese font extra dimension
      }
      return { width, actualBoundingBoxAscent: 10, actualBoundingBoxDescent: 2 };
    }
  }
  win.CanvasRenderingContext2D = CanvasRenderingContext2D;

  class HTMLCanvasElement extends HTMLElement {
    constructor() {
      super();
      this.width = 10;
      this.height = 10;
      this._ctx2d = null;
    }
    getContext(type) {
      if (type === '2d') {
        if (!this._ctx2d) this._ctx2d = new win.CanvasRenderingContext2D(this);
        return this._ctx2d;
      }
      return null;
    }
    toDataURL(type, quality) {
      const r = this._ctx2d ? this._ctx2d._pixels[0] : 0;
      const a = this._ctx2d ? this._ctx2d._pixels[3] : 0;
      return `data:image/png;base64,mockPngR${r}A${a}`;
    }
    toBlob(callback, type, quality) {
      const r = this._ctx2d ? this._ctx2d._pixels[0] : 0;
      const a = this._ctx2d ? this._ctx2d._pixels[3] : 0;
      setTimeout(() => callback({ size: 100, type: 'image/png', r, a }), 0);
    }
  }
  win.HTMLCanvasElement = HTMLCanvasElement;

  // OffscreenCanvas (main-thread coverage: engine hooks getContext /
  // convertToBlob / transferToImageBitmap / OffscreenCanvasRenderingContext2D)
  class OffscreenCanvasRenderingContext2D {
    constructor(canvas) {
      this.canvas = canvas;
      this.font = '10px sans-serif';
      this._pixels = new Uint8ClampedArray(4 * 10 * 10);
      for (let i = 0; i < this._pixels.length; i += 4) {
        this._pixels[i] = 100;     // R
        this._pixels[i + 1] = 150; // G
        this._pixels[i + 2] = 200; // B
        this._pixels[i + 3] = 255; // A
      }
    }
    getImageData(sx, sy, sw, sh) {
      return { data: new Uint8ClampedArray(this._pixels.slice(0, sw * sh * 4)) };
    }
    putImageData(imgData, dx, dy) {
      for (let i = 0; i < imgData.data.length; i++) {
        this._pixels[i] = imgData.data[i];
      }
    }
    measureText(text) {
      const font = this.font || '10px sans-serif';
      let width = (text ? text.length : 0) * 10;
      if (font.includes('SimSun') || font.includes('SimHei')) {
        width += 70;
      }
      return { width, actualBoundingBoxAscent: 10, actualBoundingBoxDescent: 2 };
    }
    // No-op rasterization (mirrors CanvasRenderingContext2d.drawImage). The
    // engine's offscreen-WebGL export path renders the source into a temp 2D
    // offscreen canvas via drawImage before perturbing it — without this
    // method that path throws and silently degrades to an unfarbled export.
    drawImage() {}
  }
  win.OffscreenCanvasRenderingContext2D = OffscreenCanvasRenderingContext2D;

  class OffscreenCanvas {
    constructor(width = 300, height = 150) {
      this.width = width;
      this.height = height;
      this._ctx = null;
      this._ctxType = null;
    }
    getContext(type) {
      if (this._ctxType !== null && this._ctxType !== type) return null; // contexts are exclusive
      if (!this._ctx) {
        this._ctxType = type;
        this._ctx = new win.OffscreenCanvasRenderingContext2D(this);
      }
      return this._ctx;
    }
    convertToBlob(options) {
      const r = (this._ctxType === '2d' && this._ctx) ? this._ctx._pixels[0] : 0;
      const a = (this._ctxType === '2d' && this._ctx) ? this._ctx._pixels[3] : 0;
      return Promise.resolve({ size: 100, type: 'image/png', r, a });
    }
    transferToImageBitmap() {
      const r = (this._ctxType === '2d' && this._ctx) ? this._ctx._pixels[0] : 0;
      const a = (this._ctxType === '2d' && this._ctx) ? this._ctx._pixels[3] : 0;
      const bitmap = { width: this.width, height: this.height, r, a };
      // Native semantics: the canvas bitmap is cleared by the transfer, but
      // the rendering context itself stays usable.
      if (this._ctx) {
        this._ctx._pixels.fill(0);
      }
      return bitmap;
    }
  }
  win.OffscreenCanvas = OffscreenCanvas;

  // WebGL Classes
  class WebGLRenderingContext {
    getParameter(param) {
      if (param === 37445) return 'Mesa/X.org';
      if (param === 37446) return 'llvmpipe (LLVM 12.0.0, 256 bits)';
      return null;
    }
    getExtension(name) {
      return null;
    }
    getSupportedExtensions() {
      return ['OES_texture_float'];
    }
    readPixels(x, y, w, h, format, type, pixels) {
      pixels[0] = 50;
      pixels[1] = 60;
      pixels[2] = 70;
      pixels[3] = 255;
    }
  }
  win.WebGLRenderingContext = WebGLRenderingContext;

  class WebGL2RenderingContext extends WebGLRenderingContext {}
  win.WebGL2RenderingContext = WebGL2RenderingContext;

  // AudioBuffer
  class AudioBuffer {
    constructor(length = 5000) {
      this.length = length;
      this._channel0 = new Float32Array(length);
      for (let i = 0; i < length; i++) {
        this._channel0[i] = Math.sin(i / 100);
      }
    }
    getChannelData(c) {
      return this._channel0;
    }
    copyFromChannel(dest, c, offset) {
      dest.set(this._channel0.subarray(offset || 0));
    }
  }
  win.AudioBuffer = AudioBuffer;

  // MediaDeviceInfo
  class MediaDeviceInfo {
    constructor(kind = 'audioinput', label = 'Realtek Audio Mic', id = 'mic-123') {
      this.deviceId = id;
      this.groupId = 'group-1';
      this.kind = kind;
      this.label = label;
    }
  }
  win.MediaDeviceInfo = MediaDeviceInfo;

  // RTCPeerConnection
  class RTCSessionDescription {
    constructor(init) {
      this.type = init.type;
      this.sdp = init.sdp;
    }
  }
  win.RTCSessionDescription = RTCSessionDescription;

  class RTCPeerConnection {
    constructor() {
      this.listeners = {};
      this._onicecandidate = null;
      this._localDescription = null;
    }
    createOffer(options) {
      const mockSDP = [
        'v=0',
        'o=- 12345 2 IN IP4 127.0.0.1',
        's=-',
        'a=candidate:1 1 UDP 2122260223 192.168.1.100 54321 typ host generation 0',
        'a=candidate:2 1 UDP 2122260223 10.0.0.5 54321 typ host generation 0',
        'a=candidate:3 1 UDP 1686052607 203.0.113.1 54321 typ srflx raddr 192.168.1.100 rport 54321',
        'a=end-of-candidates'
      ].join('\r\n');
      const desc = new win.RTCSessionDescription({ type: 'offer', sdp: mockSDP });
      this._localDescription = desc;
      return Promise.resolve(desc);
    }
    createAnswer(options) {
      return this.createOffer(options);
    }
    setLocalDescription(desc) {
      if (desc) this._localDescription = desc;
      return Promise.resolve();
    }
    get localDescription() { return this._localDescription; }
    get currentLocalDescription() { return this._localDescription; }
    get pendingLocalDescription() { return this._localDescription; }

    addEventListener(type, listener) {
      if (!this.listeners[type]) this.listeners[type] = [];
      this.listeners[type].push(listener);
    }
    removeEventListener(type, listener) {
      if (!this.listeners[type]) return;
      const idx = this.listeners[type].indexOf(listener);
      if (idx !== -1) this.listeners[type].splice(idx, 1);
    }
    dispatchEvent(event) {
      if (this.listeners[event.type]) {
        for (const l of this.listeners[event.type]) l.call(this, event);
      }
      if (event.type === 'icecandidate' && this._onicecandidate) {
        this._onicecandidate(event);
      }
    }
    get onicecandidate() { return this._onicecandidate; }
    set onicecandidate(fn) { this._onicecandidate = fn; }
  }
  win.RTCPeerConnection = RTCPeerConnection;

  // Navigator
  class Navigator {
    constructor() {
      // Native (unspoofed) identity values: with personas removed the engine
      // must pass these through verbatim.
      this.platform = platform;
      this.userAgent = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36';
      this.appVersion = '5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36';
      this.vendor = 'Apple Computer, Inc.';
      this.language = 'zh-CN';
      this.languages = ['zh-CN', 'zh'];
      this.webdriver = true;
      this.doNotTrack = null;
      this.globalPrivacyControl = false;
      this.hardwareConcurrency = 16;
      this.deviceMemory = 32;
      this.permissions = {
        query(param) {
          return Promise.resolve({ state: 'denied' });
        }
      };
      this.mediaDevices = new win.MediaDevices();
      this.geolocation = new win.Geolocation();
    }
    // Native gamepad list (engine downgrades to [] while hardwareProtection is on)
    getGamepads() {
      return [{ index: 0, id: 'Xbox 360 Controller (XInput STANDARD GAMEPAD Vendor: 045e Product: 028e)' }];
    }
  }
  class Geolocation {
    getCurrentPosition(success) {
      if (typeof success === 'function') {
        success({ coords: { latitude: 1, longitude: 2, accuracy: 100 }, timestamp: 1 });
      }
    }
    watchPosition(success) {
      if (typeof success === 'function') {
        success({ coords: { latitude: 1, longitude: 2, accuracy: 100 }, timestamp: 1 });
      }
      return 7;
    }
    clearWatch() {}
  }

  class MediaDevices {
    enumerateDevices() {
      return Promise.resolve([
        new win.MediaDeviceInfo('audioinput', 'Internal Mic', 'mic-abc-123'),
        new win.MediaDeviceInfo('videoinput', 'HD Webcam', 'cam-xyz-456')
      ]);
    }
  }
  win.MediaDevices = MediaDevices;
  // Timer primitives used by async native-style APIs (geolocation callbacks).
  win.setTimeout = (fn, ms) => setTimeout(fn, ms);
  win.clearTimeout = (id) => clearTimeout(id);
  win.Geolocation = Geolocation;
  win.Navigator = Navigator;
  win.navigator = new Navigator();

  class MemoryInfo {
    get jsHeapSizeLimit() { return 4294967296; }
    get totalJSHeapSize() { return 100000000; }
    get usedJSHeapSize() { return 50000000; }
  }
  class Performance {
    now() { return 123.456; }
  }
  win.performance = new Performance();
  win.performance.memory = new MemoryInfo();

  // Plugin
  class Plugin {
    constructor() {
      this.name = 'PDF Viewer';
      this.description = 'Portable Document Format';
      this.filename = 'internal-pdf-viewer';
    }
  }
  win.Plugin = Plugin;
  Object.defineProperty(Plugin.prototype, 'description', {
    get() { return this._desc || 'Portable Document Format'; },
    set(v) { this._desc = v; },
    configurable: true,
    enumerable: true
  });

  // Screen mock: real browsers expose width/height/availWidth/availHeight/
  // colorDepth/pixelDepth as prototype getters, so the engine's screen spoof
  // (and its Screen.prototype receiver checks) can be exercised.
  class Screen {
    constructor() {
      this._native = { width: 1920, height: 1080, availWidth: 1920, availHeight: 1080, colorDepth: 24, pixelDepth: 24 };
    }
  }
  ['width', 'height', 'availWidth', 'availHeight', 'colorDepth', 'pixelDepth'].forEach(prop => {
    Object.defineProperty(Screen.prototype, prop, {
      get() { return this._native[prop]; },
      enumerable: true,
      configurable: true
    });
  });
  win.Screen = Screen;
  win.screen = new Screen();

  // devicePixelRatio as a native-like own accessor on the window (mock native
  // value 1.25; the engine's spoof reports 1 while hardwareProtection is on).
  Object.defineProperty(win, 'devicePixelRatio', {
    get() { return 1.25; },
    set: undefined,
    enumerable: true,
    configurable: true
  });

  // WebGPU mock
  class GPU {
    requestAdapter() {
      const adapterInfo = {
        vendor: 'linux-driver',
        architecture: 'vulkan',
        device: 'RTX 3060',
        description: 'Linux Vulkan'
      };
      return Promise.resolve({
        info: Object.assign({}, adapterInfo),
        requestAdapterInfo() {
          return Promise.resolve(Object.assign({}, adapterInfo));
        }
      });
    }
  }
  win.GPU = GPU;
  win.navigator.gpu = new GPU();

  // MessageEvent mock
  win.MessageEvent = class MessageEvent {
    constructor(type, init) {
      this.type = type;
      this.data = init && init.data;
      this.origin = (init && init.origin) || '';
      this.lastEventId = (init && init.lastEventId) || '';
      this.source = (init && init.source) || null;
      this.ports = (init && init.ports) || [];
    }
  };

  win.document.head = {
    appendChild(child) {
      win.document._headChildren = win.document._headChildren || [];
      win.document._headChildren.push(child);
      return child;
    }
  };
  win.document.body = new win.HTMLElement();

  return win;
}

// ---------------------------------------------------------------------------
// Protocol-v2 config channel helpers.
//
// The engine (MAIN world) generates a random token T and a random config event
// name CE at load, announces both via '__bocchi_hs__' on document, and accepts
// config payloads only on CE and only when detail.t === T. The old fixed event
// names ('__bocchi_tz_sync__' / '__bocchi_fonts_sync__' / '__bocchi_config_sync__')
// are no longer listened to by the engine.
// ---------------------------------------------------------------------------

function findHandshakeDetail(win) {
  const events = win._dispatchedDocEvents || [];
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e && e.type === '__bocchi_hs__' && e.detail && typeof e.detail.t === 'string' && typeof e.detail.e === 'string') {
      return e.detail;
    }
  }
  return null;
}

function getEngineHandshake(win) {
  let hs = findHandshakeDetail(win);
  if (!hs) {
    // The engine missed our recorder (or loaded first): ask it to re-announce.
    // This only works while the engine is still armed (before the first
    // authenticated config event), mirroring the real bridge flow.
    win.document.dispatchEvent({ type: '__bocchi_req__' });
    hs = findHandshakeDetail(win);
  }
  if (!hs) {
    throw new Error('No __bocchi_hs__ handshake captured for ' + (win.location && win.location.hostname));
  }
  return hs;
}

// Drive an authenticated config payload into the engine.
// payload shape: { tz?, fonts?, cfg?, k? } (subset of the bridge CE payload).
function driveConfig(win, payload) {
  const hs = getEngineHandshake(win);
  win.document.dispatchEvent({
    type: hs.e,
    detail: Object.assign({ t: hs.t }, payload),
    stopImmediatePropagation() {}
  });
}

// Dispatch an event that the engine must NOT react to (forged/legacy channel).
function dispatchUnauthenticated(win, type, detail) {
  win.document.dispatchEvent({
    type: type,
    detail: detail,
    stopImmediatePropagation() {}
  });
}

// Create mock window for coveryourtracks.eff.org
const winCYT = createMockWindow('coveryourtracks.eff.org', 'Linux x86_64');
const contextCYT = vm.createContext(winCYT);
vm.runInContext(stealthCode, contextCYT);

console.log('Testing native function disguise (makeNative)...');
const toDataURL = winCYT.HTMLCanvasElement.prototype.toDataURL;
assert.strictEqual(winCYT.Function.prototype.toString.call(toDataURL), 'function toDataURL() { [native code] }');
assert.strictEqual(toDataURL.name, 'toDataURL');
assert.strictEqual(Object.prototype.hasOwnProperty.call(toDataURL, 'prototype'), false);

const getParam = winCYT.WebGLRenderingContext.prototype.getParameter;
assert.strictEqual(winCYT.Function.prototype.toString.call(getParam), 'function getParameter() { [native code] }');
assert.strictEqual(getParam.name, 'getParameter');

// Disguise checks for new timezone and font hooks
assert.strictEqual(winCYT.Function.prototype.toString.call(winCYT.Date), 'function Date() { [native code] }');
assert.strictEqual(winCYT.Function.prototype.toString.call(winCYT.Date.prototype.getTimezoneOffset), 'function getTimezoneOffset() { [native code] }');
assert.strictEqual(winCYT.Function.prototype.toString.call(winCYT.Date.prototype.toString), 'function toString() { [native code] }');
assert.strictEqual(winCYT.Function.prototype.toString.call(winCYT.Date.prototype.toTimeString), 'function toTimeString() { [native code] }');
assert.strictEqual(winCYT.Function.prototype.toString.call(winCYT.Date.prototype.toLocaleString), 'function toLocaleString() { [native code] }');
assert.strictEqual(winCYT.Function.prototype.toString.call(winCYT.Date.prototype.getHours), 'function getHours() { [native code] }');
assert.strictEqual(winCYT.Function.prototype.toString.call(winCYT.Date.prototype.setHours), 'function setHours() { [native code] }');
assert.strictEqual(winCYT.Function.prototype.toString.call(winCYT.Date.prototype.setFullYear), 'function setFullYear() { [native code] }');
assert.strictEqual(winCYT.Function.prototype.toString.call(winCYT.Date.prototype.getYear), 'function getYear() { [native code] }');
assert.strictEqual(winCYT.Function.prototype.toString.call(winCYT.Date.prototype.setYear), 'function setYear() { [native code] }');
assert.strictEqual(winCYT.Function.prototype.toString.call(winCYT.Date.parse), 'function parse() { [native code] }');
assert.strictEqual(winCYT.Function.prototype.toString.call(winCYT.Intl.DateTimeFormat), 'function DateTimeFormat() { [native code] }');
assert.strictEqual(winCYT.Function.prototype.toString.call(winCYT.Intl.DateTimeFormat.prototype.resolvedOptions), 'function resolvedOptions() { [native code] }');
assert.strictEqual(winCYT.Function.prototype.toString.call(winCYT.CanvasRenderingContext2D.prototype.measureText), 'function measureText() { [native code] }');
assert.strictEqual(winCYT.Function.prototype.toString.call(winCYT.document.fonts.check), 'function check() { [native code] }');
assert.strictEqual(winCYT.Function.prototype.toString.call(winCYT.document.fonts.load), 'function load() { [native code] }');
assert.strictEqual(winCYT.Function.prototype.toString.call(winCYT.CSSStyleDeclaration.prototype.getPropertyValue), 'function getPropertyValue() { [native code] }');

assert.strictEqual(winCYT.Function.prototype.toString.call(winCYT.Function.prototype.toString), 'function toString() { [native code] }');
assert.throws(() => winCYT.Function.prototype.toString.call({}), /TypeError/, 'Calling toString on non-function must throw TypeError');
console.log('✓ Function disguise conforms to native signatures.\n');

// nativeMap cross-realm sharing: lie detectors read a hooked API's source
// through a FOREIGN realm's Function.prototype.toString (CreepJS builds a
// nested about:blank iframe chain and uses its contentWindow as scope).
// Simulate the same-origin frame tree: realm A (parent) loads the engine and
// owns the shared registry on window.top; realm B is a child frame
// (top === A) with its OWN Function intrinsics taken from a pristine vm
// realm (an engine-free fresh realm), and loads a second engine instance.
// Before B's engine runs, B's pristine native toString must expose A's raw
// hook source (the baseline lie the sharing has to cover); after it runs,
// B's toString must resolve A's hooks through the SHARED map. A per-instance
// map would miss fnA and fall back to B's pristine native toString —
// leaking the raw source ("failed toString" lie).
const winRealmA = createMockWindow('parent.example.com', 'Linux x86_64');
vm.runInContext(stealthCode, vm.createContext(winRealmA));
const fnA = Object.getOwnPropertyDescriptor(winRealmA.Navigator.prototype, 'webdriver').get;
const winRealmB = createMockWindow('child.example.com', 'Linux x86_64');
winRealmB.top = winRealmA; // same-origin child frame: window.top reaches the parent's registry
const freshFunctionRealm = vm.createContext({});
winRealmB.Function = vm.runInContext('Function', freshFunctionRealm); // B's own pristine intrinsics
assert.notStrictEqual(winRealmB.Function.prototype.toString, winRealmA.Function.prototype.toString,
  'precondition: realm B must have an independent Function.prototype (fresh-realm simulation)');
const pristineBToString = winRealmB.Function.prototype.toString;
assert(!pristineBToString.call(fnA).includes('[native code]'),
  'precondition: an engine-free foreign realm must see the raw hook source (the lie the shared map must cover)');
vm.runInContext(stealthCode, vm.createContext(winRealmB));
assert.strictEqual(winRealmB.Function.prototype.toString.call(fnA), 'function get webdriver() { [native code] }',
  "realm B's wrapped toString must resolve realm A's hooks through the shared nativeMap (cross-realm sharing)");
const fnB = Object.getOwnPropertyDescriptor(winRealmB.Navigator.prototype, 'webdriver').get;
assert.strictEqual(winRealmA.Function.prototype.toString.call(fnB), 'function get webdriver() { [native code] }',
  "realm A's toString must resolve realm B's hooks too (the shared map is symmetric)");
console.log('✓ nativeMap is shared across same-origin realms (foreign-realm toString reads [native code]).\n');

console.log('Testing WebGL spoofing and platform detection...');
const gl = new winCYT.WebGLRenderingContext();
const expectedGpuCYT = expectedGpuProfile('coveryourtracks.eff.org');
// Pooled Intel/Mesa persona: vendor stays constant (hardware-driven), while the
// renderer is one of the five GPU_PROFILES entries picked by the site's eTLD+1
// (no salt in the key). Assert pool membership (1) and the exact entry the
// hostname selects (2); the WebGPU architecture pairing (3) is asserted in the
// apivoid realm below, where both WebGPU and WebGL are read from the same realm.
assert.strictEqual(gl.getParameter(37445), 'Google Inc. (Intel)', 'UNMASKED_VENDOR_WEBGL must be spoofed to Google Inc. (Intel)');
const cyTzRenderers = GPU_PROFILES_REF.map(p => p.renderer);
assert(cyTzRenderers.includes(gl.getParameter(37446)), 'UNMASKED_RENDERER_WEBGL must be one of the GPU profile pool renderers');
assert.strictEqual(gl.getParameter(37446), expectedGpuCYT.renderer, 'UNMASKED_RENDERER_WEBGL must be the pooled profile selected by djb2(eTLD+1) % 5');
assert.strictEqual(gl.getParameter(0x1F00), 'WebKit', 'gl.VENDOR must be WebKit');
assert.strictEqual(gl.getParameter(0x1F01), 'WebKit WebGL', 'gl.RENDERER must be WebKit WebGL');
assert.strictEqual(gl.getParameter(0x1F02), 'WebGL 1.0 (OpenGL ES 2.0 Chromium)', 'WebGL1 VERSION must be the real Chromium string');
assert.strictEqual(gl.getParameter(0x8B8C), 'WebGL GLSL ES 1.0 (OpenGL ES GLSL ES 1.0 Chromium)', 'WebGL1 SHADING_LANGUAGE_VERSION must be the real Chromium string');
const gl2 = new winCYT.WebGL2RenderingContext();
assert.strictEqual(gl2.getParameter(0x1F02), 'WebGL 2.0 (OpenGL ES 3.0 Chromium)', 'WebGL2 VERSION must be the real Chromium string');
assert.strictEqual(gl2.getParameter(0x8B8C), 'WebGL GLSL ES 3.00 (OpenGL ES GLSL ES 3.00 Chromium)', 'WebGL2 SHADING_LANGUAGE_VERSION must be the real Chromium string');
assert.strictEqual(gl.getParameter(0x0D33), 16384, 'MAX_TEXTURE_SIZE must match the Intel UHD persona (16384)');
assert.strictEqual(gl.getParameter(0x8B4D), 16, 'MAX_COMBINED_TEXTURE_IMAGE_UNITS must farble into the Intel value range (16 on CYT)');
const ext = gl.getExtension('WEBGL_debug_renderer_info');
assert(ext && ext.UNMASKED_VENDOR_WEBGL === 37445);
assert(gl.getSupportedExtensions().includes('WEBGL_debug_renderer_info'), 'getSupportedExtensions must include WEBGL_debug_renderer_info');
console.log('✓ WebGL Vendor/Renderer correctly spoofed from the pooled Intel/Mesa persona.\n');

console.log('Testing WebRTC SDP sanitization and IP suppression...');
const pc = new winCYT.RTCPeerConnection();
pc.createOffer().then(offer => {
  // Private connection addresses are replaced with 0.0.0.0 (candidate line kept).
  assert(offer.sdp.includes('a=candidate:1 1 UDP 2122260223 0.0.0.0 54321 typ host generation 0'), 'Private IPv4 candidate address must be replaced with 0.0.0.0 (host line kept)');
  assert(offer.sdp.includes('a=candidate:2 1 UDP 2122260223 0.0.0.0 54321 typ host generation 0'), 'Second private IPv4 candidate address must be replaced with 0.0.0.0');
  assert(!offer.sdp.includes('192.168.1.100 54321'), 'Raw private IPv4 address must not remain as a connection address');
  assert(!offer.sdp.includes('10.0.0.5 54321'), 'Raw private IPv4 address must not remain as a connection address');
  assert(offer.sdp.includes('203.0.113.1 54321 typ srflx'), 'Public srflx candidate should be retained');
  console.log('✓ WebRTC SDP offer private IPv4 connection addresses rewritten to 0.0.0.0.');
});
pc.createAnswer().then(answer => {
  assert(answer.sdp.includes('a=candidate:1 1 UDP 2122260223 0.0.0.0 54321 typ host generation 0'), 'Answer SDP must rewrite private candidate address to 0.0.0.0');
  assert(answer.sdp.includes('203.0.113.1 54321 typ srflx'), 'Public srflx candidate should be retained in answer SDP');
});

// Test localDescription getter sanitization
const localDesc = pc.localDescription;
assert(localDesc && localDesc.sdp.includes('a=candidate:1 1 UDP 2122260223 0.0.0.0 54321 typ host generation 0'),
  'pc.localDescription.sdp must sanitize private candidate connection addresses');

// Test setLocalDescription hook
const rawOffer = new winCYT.RTCSessionDescription({
  type: 'offer',
  sdp: 'a=candidate:1 1 UDP 2122260223 192.168.1.100 54321 typ host\r\n'
});
pc.setLocalDescription(rawOffer);
assert(pc.localDescription.sdp.includes('a=candidate:1 1 UDP 2122260223 0.0.0.0 54321 typ host'),
  'setLocalDescription with raw offer must sanitize the connection address');

// Test suppression of host candidate with a private connection address
let hostDispatched = false;
pc.onicecandidate = (e) => { hostDispatched = true; };
pc.dispatchEvent({
  type: 'icecandidate',
  candidate: { candidate: 'candidate:1 1 UDP 2122260223 192.168.1.100 54321 typ host generation 0' }
});
assert.strictEqual(hostDispatched, false, 'Private IP host candidate event must be suppressed');

// STUN srflx candidate with a public connection address is delivered: the new
// sanitizer only inspects the candidate connection address (field 5), so a
// private raddr no longer suppresses the whole candidate.
let srflxDispatched = false;
pc.onicecandidate = (e) => { srflxDispatched = true; };
pc.dispatchEvent({
  type: 'icecandidate',
  candidate: { candidate: 'candidate:3 1 UDP 1686052607 203.0.113.1 54321 typ srflx raddr 192.168.1.100 rport 54321' }
});
assert.strictEqual(srflxDispatched, true, 'srflx candidate with public connection address must be delivered (raddr no longer suppresses)');
console.log('✓ WebRTC candidate suppression targets private connection addresses only.\n');

console.log('Testing MediaDevices device enumeration anonymization & prototype...');
winCYT.navigator.mediaDevices.enumerateDevices().then(devices => {
  assert(Array.isArray(devices) && devices.length > 0, 'enumerateDevices must return devices array');
  for (const d of devices) {
    assert.strictEqual(d.deviceId, '', 'deviceId must be blank');
    assert.strictEqual(d.groupId, '', 'groupId must be blank');
    assert.strictEqual(d.label, '', 'label must be blank');
    assert(d.kind === 'audioinput' || d.kind === 'videoinput', 'kind must be preserved');
    assert(d instanceof winCYT.MediaDeviceInfo, 'Device must preserve MediaDeviceInfo prototype');
  }
  console.log('✓ Media devices enumerateDevices successfully anonymized and retains MediaDeviceInfo prototype.\n');
});

console.log('Testing DOMRect geometry integrity and Font metrics...');
const el = new winCYT.Element();
const rect = el.getBoundingClientRect();
assert(rect instanceof winCYT.DOMRect, 'getBoundingClientRect must return instanceof DOMRect');
assert.strictEqual(rect.x, rect.left, 'rect.x must equal rect.left');
assert.strictEqual(rect.y, rect.top, 'rect.y must equal rect.top');
assert.strictEqual(rect.width, rect.right - rect.left, 'rect.width must equal rect.right - rect.left');
assert.strictEqual(rect.height, rect.bottom - rect.top, 'rect.height must equal rect.bottom - rect.top');

const htmlEl = new winCYT.HTMLElement();
assert.strictEqual(typeof htmlEl.offsetWidth, 'number', 'offsetWidth must be a number');
assert.strictEqual(Number.isInteger(htmlEl.offsetWidth), true, 'offsetWidth must be an integer (WebIDL long)');
assert.strictEqual(Number.isInteger(htmlEl.offsetHeight), true, 'offsetHeight must be an integer (WebIDL long)');
console.log('✓ DOMRect geometric identities and integer font dimensions verified.\n');

console.log('Testing Navigator, Language, and Privacy Properties...');
assert.strictEqual(winCYT.navigator.webdriver, false, 'navigator.webdriver must be false');
// doNotTrack injection removed: DNT is expressed at the network layer (DNR
// header) and navigator.doNotTrack must pass through the mock's native value
// (null here) untouched — overriding it is itself a spoofing signal.
assert.strictEqual(winCYT.navigator.doNotTrack, null, 'navigator.doNotTrack must pass through natively (mock native value, no engine override)');
assert.strictEqual(winCYT.navigator.globalPrivacyControl, true, 'navigator.globalPrivacyControl must be true');
assert.strictEqual(winCYT.doNotTrack, undefined, 'window.doNotTrack must NOT exist (avoids obsolete IE9 pollution)');
// Passthrough must not be "always null": a native truthy value survives verbatim.
const winDntNative = createMockWindow('dnt-native.test', 'Linux x86_64');
winDntNative.navigator.doNotTrack = '1';
vm.runInContext(stealthCode, vm.createContext(winDntNative));
assert.strictEqual(winDntNative.navigator.doNotTrack, '1', 'A native doNotTrack value must pass through unchanged (no engine override in either direction)');

// Browser Platform, UA, and Language: personas removed — everything passes
// through natively (mock provides the values, engine must not touch them).
const NATIVE_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36';
assert.strictEqual(winCYT.navigator.platform, 'Linux x86_64', 'navigator.platform must pass through the native value');
assert.strictEqual(winCYT.navigator.userAgent, NATIVE_UA, 'navigator.userAgent must pass through the native value (no UA persona)');
assert.strictEqual(winCYT.navigator.appVersion, '5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36', 'navigator.appVersion must pass through the native value');
assert.strictEqual(winCYT.navigator.vendor, 'Apple Computer, Inc.', 'navigator.vendor must pass through the native value');
assert.strictEqual(winCYT.navigator.deviceMemory, 32, 'navigator.deviceMemory must pass through the native value (no degradation: SharedWorker consistency)');
assert.strictEqual(winCYT.navigator.language, 'zh-CN', 'navigator.language must pass through the native value');
assert.deepStrictEqual([...winCYT.navigator.languages], ['zh-CN', 'zh'], 'navigator.languages must pass through the native array (same reference semantics)');
console.log('✓ Browser identity passes through natively; hardware values are native too (SharedWorker consistency).\n');

// window.chrome: the engine only ensures the object exists (an empty object
// still defeats `typeof chrome === 'undefined'` headless probes); the persona-era
// app/csi/loadTimes builtins were removed.
assert(winCYT.chrome && typeof winCYT.chrome === 'object', 'window.chrome object must be present');
assert.strictEqual(winCYT.chrome.csi, undefined, 'window.chrome.csi must NOT be emulated anymore (persona removal)');
assert.strictEqual(winCYT.chrome.loadTimes, undefined, 'window.chrome.loadTimes must NOT be emulated anymore');
console.log('✓ Navigator, privacy flags, and window.chrome presence verified.\n');

console.log('Testing Intl Locale Pass-through...');
// Persona removal: Intl locales pass through natively. Only the timezone is
// aligned (hooked separately below); 'en' resolves to 'en', zh* stays zh*.
const nativeDefaultDTFLocale = new Intl.DateTimeFormat().resolvedOptions().locale;
const dtf = new winCYT.Intl.DateTimeFormat();
assert.strictEqual(dtf.resolvedOptions().locale, nativeDefaultDTFLocale, 'DateTimeFormat locale must pass through natively (host default)');
assert.strictEqual(new winCYT.Intl.DateTimeFormat('zh-CN').resolvedOptions().locale, new Intl.DateTimeFormat('zh-CN').resolvedOptions().locale, 'DateTimeFormat zh-CN locale must be preserved natively');

const nf = new winCYT.Intl.NumberFormat();
assert.strictEqual(nf.resolvedOptions().locale, new Intl.NumberFormat().resolvedOptions().locale, 'NumberFormat locale must pass through natively');
assert.strictEqual(nf.format(1234567.89), new Intl.NumberFormat().format(1234567.89), 'NumberFormat formatting must be fully native');

// Test empty array and Chinese locales handling (native semantics)
assert.strictEqual(new winCYT.Intl.NumberFormat([]).resolvedOptions().locale, new Intl.NumberFormat().resolvedOptions().locale, 'Empty locales array must fall back to the native default');
assert.strictEqual(new winCYT.Intl.NumberFormat(['zh-CN']).resolvedOptions().locale, new Intl.NumberFormat(['zh-CN']).resolvedOptions().locale, 'Chinese locale array must resolve natively');
assert.strictEqual(new winCYT.Intl.NumberFormat(['zh-CN', 'en-US']).resolvedOptions().locale, new Intl.NumberFormat(['zh-CN', 'en-US']).resolvedOptions().locale, 'Mixed locale array resolves natively');

const pr = new winCYT.Intl.PluralRules();
// PluralRules legitimately collapses 'en-US' to 'en' (plural rules carry no
// regional data); the engine leaves this native resolution untouched.
assert.strictEqual(pr.resolvedOptions().locale, new Intl.PluralRules().resolvedOptions().locale, 'PluralRules locale must keep its native resolved value');
assert.strictEqual(new winCYT.Intl.PluralRules('zh-CN').resolvedOptions().locale, new Intl.PluralRules('zh-CN').resolvedOptions().locale, 'PluralRules zh-CN must pass through natively (no remap)');

const rtf = new winCYT.Intl.RelativeTimeFormat();
assert.strictEqual(rtf.resolvedOptions().locale, new Intl.RelativeTimeFormat().resolvedOptions().locale, 'RelativeTimeFormat locale must pass through natively');

const col = new winCYT.Intl.Collator();
assert.strictEqual(col.resolvedOptions().locale, new Intl.Collator().resolvedOptions().locale, 'Collator locale must pass through natively');
console.log('✓ Intl locale passthrough verified (zh preserved, timezone still aligned).\n');

console.log('Testing Timezone Dynamic Auto-sync and Date Hooks...');
// Host real zone (defined once, reused by the passthrough block below).
// The LA-targeted assertions in this block test the engine's CONVERSION to
// America/Los_Angeles and are host-independent; only the native-string
// equality checks require the host to actually be in LA (target == real zone
// -> passthrough), so they are guarded.
const HOST_REAL_TZ = Intl.DateTimeFormat().resolvedOptions().timeZone;
// Initial timezone matches America/Los_Angeles
assert.strictEqual(dtf.resolvedOptions().timeZone, 'America/Los_Angeles', 'Default detected timezone must be America/Los_Angeles');

const testDateSummer = new winCYT.Date('2026-09-29T12:00:00Z');
const nativeDateSummer = new Date('2026-09-29T12:00:00Z');
// In Los Angeles (PDT): offset is 420 minutes (UTC-7)
assert.strictEqual(testDateSummer.getTimezoneOffset(), 420, 'getTimezoneOffset in Summer (PDT) must be 420');
assert(testDateSummer.toString().includes('GMT-0700'), 'Date.toString must include GMT-0700');
// Native-string equality only holds when the host really is in LA (target ==
// real zone -> full passthrough). On other hosts the engine converts and
// renders LA itself; the general passthrough case is covered by the
// HOST_REAL_TZ-driven block further below.
if (HOST_REAL_TZ === 'America/Los_Angeles') {
  assert.strictEqual(testDateSummer.toString(), nativeDateSummer.toString(), 'Date.toString must match the native string when the target zone equals the real zone');
  assert.strictEqual(testDateSummer.toTimeString(), nativeDateSummer.toTimeString(), 'toTimeString must match the native string when the target zone equals the real zone');
}
assert.strictEqual(testDateSummer.toDateString(), 'Tue Sep 29 2026', 'toDateString must match Tue Sep 29 2026');
assert.strictEqual(testDateSummer.getHours(), 5, 'getHours in LA for 12:00 UTC must be 5 (12 - 7)');
assert(testDateSummer.toLocaleString().includes('2026'), 'toLocaleString must format in the native default locale (year present)');
assert(testDateSummer.toLocaleString('en-US').includes('9/29/2026'), 'Explicit en-US toLocaleString must be respected natively');
assert(testDateSummer.toLocaleString('en-US').includes('5:00:00 AM'), 'toLocaleString must format time in Pacific Time');

// Test Date local getters consistency in activeTimezone
assert.strictEqual(testDateSummer.getHours(), 5, 'getHours in LA for 12:00 UTC must be 5');
assert.strictEqual(testDateSummer.getMinutes(), 0, 'getMinutes must be 0');
assert.strictEqual(testDateSummer.getSeconds(), 0, 'getSeconds must be 0');
assert.strictEqual(testDateSummer.getDate(), 29, 'getDate must be 29');
assert.strictEqual(testDateSummer.getMonth(), 8, 'getMonth must be 8 (September)');
assert.strictEqual(testDateSummer.getFullYear(), 2026, 'getFullYear must be 2026');
assert.strictEqual(testDateSummer.getYear(), 126, 'getYear must be 126');

// Test Date() without new returns string and matches new Date().toString()
assert.strictEqual(typeof winCYT.Date(), 'string', 'Date() without new must return string');
assert.strictEqual(winCYT.Date(), (new winCYT.Date()).toString(), 'Date() without new must match (new Date()).toString()');

// Test Date local setter in active timezone
const modDate = new winCYT.Date('2026-09-29T12:00:00Z');
modDate.setHours(15);
assert.strictEqual(modDate.getHours(), 15, 'setHours(15) must result in getHours() === 15 in active timezone');

// Test zero window backdoor leakage
assert.strictEqual('__BOCCHI_TIMEZONE__' in winCYT, false, '__BOCCHI_TIMEZONE__ must NOT be defined on window');
assert.strictEqual('__BOCCHI_SESSION_SALT__' in winCYT, false, '__BOCCHI_SESSION_SALT__ must NOT be defined on window');
assert.strictEqual('__bocchiSetTimezone' in winCYT, false, '__bocchiSetTimezone must NOT be defined on window');

function setTestTimezone(win, tz) {
  // Protocol v2: timezone updates travel over the authenticated CE channel.
  driveConfig(win, { tz: tz });
}

// Test dynamic Intl.DateTimeFormat timezone tracking for default instances
const dtfDyn = new winCYT.Intl.DateTimeFormat();
assert.strictEqual(dtfDyn.resolvedOptions().timeZone, 'America/Los_Angeles');
setTestTimezone(winCYT, 'Europe/London');
assert.strictEqual(dtfDyn.resolvedOptions().timeZone, 'Europe/London', 'Default dtf instance must dynamically track timezone update');
setTestTimezone(winCYT, 'America/Los_Angeles');

const testDateWinter = new winCYT.Date('2026-01-15T12:00:00Z');
const nativeDateWinter = new Date('2026-01-15T12:00:00Z');
// In Los Angeles (PST): offset is 480 minutes (UTC-8)
assert.strictEqual(testDateWinter.getTimezoneOffset(), 480, 'getTimezoneOffset in Winter (PST) must be 480');
assert(testDateWinter.toString().includes('GMT-0800'), 'Date.toString must include GMT-0800');
// Native-string equality is host-LA-guarded (see the summer block above).
if (HOST_REAL_TZ === 'America/Los_Angeles') {
  assert.strictEqual(testDateWinter.toString(), nativeDateWinter.toString(), 'Winter Date.toString must match the native string (target zone == real zone)');
}
assert.strictEqual(testDateWinter.getHours(), 4, 'getHours in LA for 12:00 UTC in Winter must be 4 (12 - 8)');
assert.strictEqual(testDateWinter.getMinutes(), 0, 'getMinutes must be 0');
assert.strictEqual(testDateWinter.getSeconds(), 0, 'getSeconds must be 0');
assert.strictEqual(testDateWinter.getDate(), 15, 'getDate must be 15');
assert.strictEqual(testDateWinter.getDay(), 4, 'getDay must be 4');
assert.strictEqual(testDateWinter.getMonth(), 0, 'getMonth must be 0');
assert.strictEqual(testDateWinter.getFullYear(), 2026, 'getFullYear must be 2026');
assert.strictEqual(testDateWinter.getYear(), 126, 'getYear must be 126');

// Test Dynamic Timezone Switching to America/New_York
setTestTimezone(winCYT, 'America/New_York');
assert.strictEqual(new winCYT.Intl.DateTimeFormat().resolvedOptions().timeZone, 'America/New_York', 'DateTimeFormat must reflect updated timezone');
assert.strictEqual(new winCYT.Date('2026-09-29T12:00:00Z').getTimezoneOffset(), 240, 'Summer offset in NY (EDT) must be 240 (UTC-4)');
// The engine only formats the English zone name itself when conversion is
// active (target != real zone). When the host really is in NY, passthrough
// renders the native (host-locale) name instead.
if ('America/New_York' !== HOST_REAL_TZ) {
  assert(new winCYT.Date('2026-09-29T12:00:00Z').toString().includes('GMT-0400 (Eastern Daylight Time)'), 'Date.toString must reflect NY EDT');
} else {
  assert.strictEqual(new winCYT.Date('2026-09-29T12:00:00Z').toString(), new Date('2026-09-29T12:00:00Z').toString(), 'NY-host passthrough must render the native string');
}
assert.strictEqual(new winCYT.Date('2026-09-29T12:00:00Z').getHours(), 8, 'getHours in NY for 12:00 UTC must be 8 (12 - 4)');

// Test Dynamic Timezone Switching to Asia/Tokyo (UTC+9)
setTestTimezone(winCYT, 'Asia/Tokyo');
assert.strictEqual(new winCYT.Date('2026-09-29T12:00:00Z').getTimezoneOffset(), -540, 'Offset in Tokyo must be -540 (UTC+9)');
if ('Asia/Tokyo' !== HOST_REAL_TZ) {
  assert(new winCYT.Date('2026-09-29T12:00:00Z').toString().includes('GMT+0900 (Japan Standard Time)'), 'Date.toString must reflect Tokyo JST');
} else {
  assert.strictEqual(new winCYT.Date('2026-09-29T12:00:00Z').toString(), new Date('2026-09-29T12:00:00Z').toString(), 'Tokyo-host passthrough must render the native string');
}
assert.strictEqual(new winCYT.Date('2026-09-29T12:00:00Z').getHours(), 21, 'getHours in Tokyo for 12:00 UTC must be 21 (12 + 9)');

// Test authenticated CE timezone sync and ensure window.postMessage is ignored
driveConfig(winCYT, { tz: 'Europe/Paris' });
assert.strictEqual(new winCYT.Intl.DateTimeFormat().resolvedOptions().timeZone, 'Europe/Paris', 'Authenticated CE payload must sync timezone');
winCYT.postMessage({ type: '__BOCCHI_TIMEZONE_UPDATE__', timezone: 'Asia/Shanghai' }, '*');
assert.strictEqual(new winCYT.Intl.DateTimeFormat().resolvedOptions().timeZone, 'Europe/Paris', 'postMessage must not sync timezone');

// Reset back to America/Los_Angeles
setTestTimezone(winCYT, 'America/Los_Angeles');

// Non-constructor invocation (without new)
const dtfNoNew = winCYT.Intl.DateTimeFormat();
assert.strictEqual(dtfNoNew.resolvedOptions().locale, nativeDefaultDTFLocale, 'DateTimeFormat without new must resolve to the native default locale');
assert.strictEqual(dtfNoNew.resolvedOptions().timeZone, 'America/Los_Angeles', 'DateTimeFormat without new must resolve to America/Los_Angeles');

// UTC and ISO string methods preservation
const testDateUTC = new winCYT.Date('2026-09-29T12:00:00.000Z');
assert.strictEqual(testDateUTC.toISOString(), '2026-09-29T12:00:00.000Z', 'toISOString must preserve pure UTC time');
assert.strictEqual(testDateUTC.getUTCHours(), 12, 'getUTCHours must return 12 in UTC');

// Custom explicit timeZone in toLocaleString must be respected
assert(testDateUTC.toLocaleString('en-GB', { timeZone: 'UTC' }).includes('12:00:00'), 'Explicit timeZone in toLocaleString must be respected');

// tzSpoofNeeded: when the target zone IS the host's real zone (the common
// "no VPN / matching exit IP" case) the assertions below only pin VALUE
// equivalence with the unwrapped natives (same offsets, same rendered
// strings). Mutation experiments show they do NOT discriminate the wrapping
// itself — a still-hooked-but-value-correct implementation passes them too.
// Discriminating the hook/disarm logic relies on the America/New_York and
// Asia/Tokyo conversion assertions above (offset/hours must follow the
// TARGET zone, not the host zone) and on the per-window Date isolation
// (independent WDate subclasses per mock realm, see createMockWindow).
// The real zone is read from the environment (HOST_REAL_TZ, defined in the
// LA block above) so the test stays valid on any host TZ.
const winSameTz = createMockWindow('same-tz-passthrough.test', 'Linux x86_64');
vm.runInContext(stealthCode, vm.createContext(winSameTz));
driveConfig(winSameTz, { tz: HOST_REAL_TZ });
assert.strictEqual(new winSameTz.Intl.DateTimeFormat().resolvedOptions().timeZone, HOST_REAL_TZ, 'Target == real zone must resolve to the real zone');
assert.strictEqual(new winSameTz.Intl.DateTimeFormat('en-US', { timeZoneName: 'long' }).resolvedOptions().timeZone, HOST_REAL_TZ, 'Explicit-formatter resolvedOptions must stay native when target == real');
const sameTzProbe = '2026-09-29T12:00:00Z';
assert.strictEqual(new winSameTz.Date(sameTzProbe).getHours(), new Date(sameTzProbe).getHours(), 'getHours must equal the native value when target == real zone');
assert.strictEqual(new winSameTz.Date(sameTzProbe).getTimezoneOffset(), new Date(sameTzProbe).getTimezoneOffset(), 'getTimezoneOffset must equal the native value when target == real zone');
assert.strictEqual(new winSameTz.Date(sameTzProbe).toString(), new Date(sameTzProbe).toString(), 'Date.toString must equal the native string when target == real zone');
assert.strictEqual(new winSameTz.Date(sameTzProbe).getMinutes(), new Date(sameTzProbe).getMinutes(), 'getMinutes must equal the native value (no sub-minute offset shifts)');
console.log('✓ Timezone value equivalence confirmed when the target zone equals the host real zone (wrapping discrimination: NY/Tokyo conversions + Date isolation).\n');

// DST rollback hour and non-hour offsets: the conversion path must agree with
// what a native realm in that zone reports (the engine fixed the repeated
// 02:00-03:00 rollback hour and sub-minute offsets). 2026-10-25 is Paris's
// fall-back: 00:30Z is the first (CEST) pass, 01:30Z the second (CET) pass —
// both must render 02:30 local, with different offsets.
setTestTimezone(winSameTz, 'Europe/Paris');
const parisRollbackFirst = new winSameTz.Date('2026-10-25T00:30:00Z');
const parisRollbackSecond = new winSameTz.Date('2026-10-25T01:30:00Z');
assert.strictEqual(parisRollbackFirst.getHours(), 2, 'First pass through the rollback hour must be 02:xx local');
assert.strictEqual(parisRollbackFirst.getMinutes(), 30, 'Rollback-hour minutes must not shift (no sub-minute drift)');
assert.strictEqual(parisRollbackFirst.getTimezoneOffset(), -120, 'First rollback pass must report CEST (+0200)');
assert.strictEqual(parisRollbackSecond.getHours(), 2, 'Second pass through the rollback hour must also be 02:xx local');
assert.strictEqual(parisRollbackSecond.getTimezoneOffset(), -60, 'Second rollback pass must report CET (+0100)');
setTestTimezone(winSameTz, 'Asia/Kolkata');
const kolkataDate = new winSameTz.Date('2026-09-29T12:00:00Z');
assert.strictEqual(kolkataDate.getTimezoneOffset(), -330, 'Half-hour zone (Kolkata, UTC+5:30) offset must be -330');
assert.strictEqual(kolkataDate.getHours(), 17, 'Kolkata hours must be 17 for 12:00 UTC');
assert.strictEqual(kolkataDate.getMinutes(), 30, 'Kolkata minutes must be 30 (half-hour offset preserved exactly)');
assert(kolkataDate.toString().includes('GMT+0530'), 'Kolkata Date.toString must include GMT+0530');
console.log('✓ DST rollback hour and half-hour offset semantics match native behaviour.\n');

// Sub-minute LMT-era offsets: historical Monrovia ran at UTC-0:44:30. The
// engine must agree with what a native realm in that zone reports — exact
// wall clock (11:50:26 for 12:34:56Z) and V8's truncated offset fields:
// getTimezoneOffset 44 and toString GMT-0044 (Math.trunc toward zero, NOT
// Math.round's 45). Expected values verified against a native
// TZ=Africa/Monrovia Node run (ICU/tzdata ground truth).
setTestTimezone(winSameTz, 'Africa/Monrovia');
const monroviaDate = new winSameTz.Date('1969-06-15T12:34:56Z');
assert.strictEqual(monroviaDate.getHours(), 11, 'LMT-era Monrovia getHours must be 11 for 12:34:56Z (UTC-0:44:30)');
assert.strictEqual(monroviaDate.getMinutes(), 50, 'LMT-era Monrovia minutes must be 50 (sub-minute offset must not shift the minute)');
assert.strictEqual(monroviaDate.getSeconds(), 26, 'LMT-era Monrovia seconds must be 26');
assert.strictEqual(monroviaDate.getTimezoneOffset(), 44, 'LMT-era Monrovia getTimezoneOffset must be 44 (V8 truncates -0:44:30 toward zero, not 45)');
assert(monroviaDate.toString().includes('GMT-0044'), 'LMT-era Monrovia toString must carry the truncated GMT-0044 field');
console.log('✓ Sub-minute LMT-era offsets match native Monrovia semantics (truncated GMT fields, exact wall clock).\n');

// Chinese locale in toLocaleString must be sanitized to English
assert(!testDateUTC.toLocaleString('zh-CN').includes('上午') && !testDateUTC.toLocaleString('zh-CN').includes('下午'), 'Chinese locale in toLocaleString must default to English format');

// Invalid Date handling and TypeError on invalid receiver
const invDate = new winCYT.Date('invalid');
assert.strictEqual(invDate.toString(), 'Invalid Date', 'Invalid Date toString must return "Invalid Date"');
assert.strictEqual(invDate.toTimeString(), 'Invalid Date', 'Invalid Date toTimeString must return "Invalid Date"');
assert.strictEqual(invDate.toDateString(), 'Invalid Date', 'Invalid Date toDateString must return "Invalid Date"');
assert.strictEqual(invDate.toLocaleString(), 'Invalid Date', 'Invalid Date toLocaleString must return "Invalid Date"');
assert(isNaN(invDate.getTimezoneOffset()), 'Invalid Date getTimezoneOffset must be NaN');
assert(isNaN(invDate.getHours()), 'Invalid Date getHours must be NaN');
assert(isNaN(invDate.getMinutes()), 'Invalid Date getMinutes must be NaN');
assert(isNaN(invDate.getSeconds()), 'Invalid Date getSeconds must be NaN');
assert(isNaN(invDate.getDate()), 'Invalid Date getDate must be NaN');
assert(isNaN(invDate.getDay()), 'Invalid Date getDay must be NaN');
assert(isNaN(invDate.getMonth()), 'Invalid Date getMonth must be NaN');
assert(isNaN(invDate.getFullYear()), 'Invalid Date getFullYear must be NaN');
assert(isNaN(invDate.getYear()), 'Invalid Date getYear must be NaN');
assert.throws(() => winCYT.Date.prototype.toString.call({}), /TypeError/, 'Date.toString on non-Date receiver must throw TypeError');
assert.throws(() => winCYT.Date.prototype.getTimezoneOffset.call({}), /TypeError/, 'Date.getTimezoneOffset on non-Date receiver must throw TypeError');
['getHours', 'getMinutes', 'getSeconds', 'getDate', 'getDay', 'getMonth', 'getFullYear', 'getYear'].forEach(fn => {
  assert.throws(() => winCYT.Date.prototype[fn].call({}), /TypeError/, `Date.${fn} on non-Date receiver must throw TypeError`);
});
console.log('✓ Dynamic Timezone Auto-sync, Date hooks, and error handling verified.\n');

console.log('Testing Font Fingerprint Masking (Hide Chinese Fonts)...');
// 1. Canvas measureText masking
const canvasFont = new winCYT.HTMLCanvasElement();
const ctxFont = canvasFont.getContext('2d');

ctxFont.font = '72px "SimSun", monospace';
const widthSimSun = ctxFont.measureText('mmmmmm').width;

ctxFont.font = '72px monospace';
const widthFallback = ctxFont.measureText('mmmmmm').width;
assert.strictEqual(widthSimSun, widthFallback, 'SimSun probe must match monospace fallback metric exactly');

ctxFont.font = '72px "Microsoft YaHei", sans-serif';
const widthYaHei = ctxFont.measureText('mmmmmm').width;
ctxFont.font = '72px sans-serif';
const widthSans = ctxFont.measureText('mmmmmm').width;
assert.strictEqual(widthYaHei, widthSans, 'Microsoft YaHei probe must match sans-serif fallback metric exactly');

// 2. DOM probe offsetWidth and offsetHeight masking (inline styles)
const probeEl = new winCYT.HTMLElement();
probeEl.style.fontFamily = '"SimSun", monospace';
assert.strictEqual(probeEl.offsetWidth, 150, 'SimSun probe offsetWidth must mask to fallback 150');
assert.strictEqual(probeEl.offsetHeight, 76, 'SimSun probe offsetHeight must mask to fallback 76');

// 2.1 Solitary Chinese font probe (BrowserLeaks style: single font name without generic fallback)
const singleProbeEl = new winCYT.HTMLElement();
singleProbeEl.style.fontFamily = 'SimSun';
assert.strictEqual(singleProbeEl.offsetWidth, 150, 'Solitary SimSun probe offsetWidth must mask to fallback 150 without leaking sans-serif');
assert.strictEqual(singleProbeEl.offsetHeight, 76, 'Solitary SimSun probe offsetHeight must mask to fallback 76');

// 3. DOM probe getBoundingClientRect masking (inline styles)
const probeRect = probeEl.getBoundingClientRect();
assert.strictEqual(probeRect.width, 100, 'SimSun probe getBoundingClientRect width must mask to fallback 100');

// 4. DOM probe with class/stylesheet-styled font (no inline declaration):
// the new fast-path precheck (M1) only masks layout reads when an inline
// font declaration (style property or SVG presentation attribute) matches a
// hidden-font signature — CSS-class-styled probes pass through to native
// layout to avoid getComputedStyle calls, style rewrites and forced reflows.
const classEl = new winCYT.HTMLElement();
classEl._computedFontFamily = '"SimSun", monospace';
assert.strictEqual(classEl.offsetWidth, 220, 'Class-styled probe without inline declaration passes through to native layout (M1 fast path)');
assert.strictEqual(classEl.offsetHeight, 110, 'Class-styled probe offsetHeight passes through (M1 fast path)');
assert.strictEqual(classEl.getBoundingClientRect().width, 180, 'Class-styled probe getBoundingClientRect passes through (M1 fast path)');

// 5. CSSStyleDeclaration font masking (still applies to computed-style reads)
const computedStyle = winCYT.getComputedStyle(classEl);
assert.strictEqual(computedStyle.fontFamily, 'monospace', 'getComputedStyle.fontFamily must mask SimSun');
assert.strictEqual(computedStyle.getPropertyValue('font-family'), 'monospace', 'getComputedStyle.getPropertyValue must mask SimSun');

// 6. Standard English font metrics integrity
probeEl.style.fontFamily = 'Arial, sans-serif';
assert.strictEqual(probeEl.offsetWidth, 150, 'Standard English font returns true element dimensions 150');

// 7. document.fonts.check masking
assert.strictEqual(winCYT.document.fonts.check('12px "SimSun"'), false, 'Chinese font SimSun check must return false');
assert.strictEqual(winCYT.document.fonts.check('16px "Microsoft YaHei"'), false, 'Chinese font Microsoft YaHei check must return false');
assert.strictEqual(winCYT.document.fonts.check('14px "WenQuanYi Micro Hei"'), false, 'Chinese font WenQuanYi check must return false');
assert.strictEqual(winCYT.document.fonts.check('14px "PingFang SC"'), false, 'Chinese font PingFang check must return false');
assert.strictEqual(winCYT.document.fonts.check('16px Arial'), true, 'Standard English font Arial check must return true');
assert.strictEqual(winCYT.document.fonts.check('14px "Times New Roman"'), true, 'Standard English font Times New Roman check must return true');
// 7.1 speechSynthesis.getVoices Linux normalization
const voices = winCYT.speechSynthesis.getVoices();
assert(Array.isArray(voices) && voices.length >= 3, 'speechSynthesis.getVoices must return standard voices array');
assert(voices.some(v => v.name && v.name.includes('Google US English')), 'speechSynthesis must include Google US English');
assert(!voices.some(v => v.name && v.name.includes('Microsoft')), 'Must not leak Microsoft voices on Linux');
assert(winCYT.speechSynthesis.getVoices.toString().includes('[native code]'), 'speechSynthesis.getVoices must appear native');

// 8. document.fonts.load masking
winCYT.document.fonts.load('16px "SimSun"').then(fonts => {
  assert.strictEqual(fonts.length, 0, 'fonts.load for SimSun must return empty array');
});
winCYT.document.fonts.load('16px Arial').then(fonts => {
  assert.strictEqual(fonts.length, 1, 'fonts.load for Arial must return font face');
});

// 9. queryLocalFonts masking
winCYT.queryLocalFonts().then(fonts => {
  assert(Array.isArray(fonts) && fonts.length > 0, 'queryLocalFonts must return array');
  for (const f of fonts) {
    assert(!f.family.includes('SimSun'), 'queryLocalFonts must not contain SimSun');
    assert(!f.family.includes('Microsoft YaHei'), 'queryLocalFonts must not contain Microsoft YaHei');
  }
  const families = fonts.map(f => f.family);
  assert(families.includes('Arial'), 'queryLocalFonts must retain Arial');
  assert(families.includes('Times New Roman'), 'queryLocalFonts must retain Times New Roman');
  console.log('✓ queryLocalFonts correctly masks Chinese fonts while retaining English fonts.');
});

// 10. DOM Range font masking (TraceScope domRange detection)
const rangeSpan = new winCYT.HTMLElement();
rangeSpan.style.fontFamily = '"SimSun", monospace';
const range = winCYT.document.createRange();
range.selectNode(rangeSpan);
const rangeRect = range.getBoundingClientRect();
assert.strictEqual(rangeRect.width, 100, 'Range.getBoundingClientRect must mask SimSun to monospace fallback width 100');
const rangeRects = range.getClientRects();
assert.strictEqual(rangeRects[0].width, 100, 'Range.getClientRects must mask SimSun to monospace fallback width 100');
assert.strictEqual(rangeSpan.style.fontFamily, '"SimSun", monospace', 'Inline style restored after range measurement');

// 11. SVG font masking (TraceScope svg detection)
const svgText = new winCYT.SVGTextContentElement();
svgText.setAttribute('font-family', '"SimHei", sans-serif');
assert.strictEqual(svgText.getComputedTextLength(), 100, 'SVGTextContentElement.getComputedTextLength must mask SimHei to 100');
assert.strictEqual(svgText.getAttribute('font-family'), '"SimHei", sans-serif', 'SVG font-family attribute restored after measurement');
const svgG = new winCYT.SVGGraphicsElement();
svgG.setAttribute('font-family', '"SimSun", monospace');
assert.strictEqual(svgG.getBBox().width, 100, 'SVGGraphicsElement.getBBox must mask SimSun to 100');
assert.strictEqual(svgG.getAttribute('font-family'), '"SimSun", monospace', 'SVG font-family attribute restored after getBBox');

// 11.1 Custom hidden font management and dynamic synchronization
driveConfig(winCYT, { fonts: {
  customFonts: ['CustomBrandFont', '/secret-font-\\d+/'],
  allowedFonts: ['SimSun'], // Explicitly whitelist SimSun
  blockBuiltin: true
} });

assert.strictEqual(winCYT.document.fonts.check('16px "CustomBrandFont"'), false, 'Custom brand font check must return false');
assert.strictEqual(winCYT.document.fonts.check('16px "secret-font-99"'), false, 'Regex-matched custom font check must return false');
assert.strictEqual(winCYT.document.fonts.check('16px Arial'), true, 'Standard Arial font check must still return true');
assert.strictEqual(winCYT.document.fonts.check('16px "SimSun"'), true, 'Explicitly whitelisted SimSun check must return true');

const customProbeEl = new winCYT.HTMLElement();
customProbeEl.style.fontFamily = 'CustomBrandFont';
assert.strictEqual(customProbeEl.offsetWidth, 150, 'Custom font offsetWidth must mask to fallback');

// Reset SimSun back to masked
driveConfig(winCYT, { fonts: { customFonts: [], allowedFonts: [], blockBuiltin: true } });
assert.strictEqual(winCYT.document.fonts.check('12px "SimSun"'), false, 'SimSun must be masked after reset');

// 11.2 Whitelist Mode validation
driveConfig(winCYT, { fonts: {
  fontMode: 'whitelist',
  allowedFonts: ['Arial', 'Liberation Sans'],
  customFonts: [],
  blockBuiltin: true
} });
assert.strictEqual(winCYT.document.fonts.check('16px Arial'), true, 'Whitelisted Arial must return true');
assert.strictEqual(winCYT.document.fonts.check('16px "Liberation Sans"'), true, 'Whitelisted Liberation Sans must return true');
assert.strictEqual(winCYT.document.fonts.check('16px "Times New Roman"'), false, 'Non-whitelisted Times New Roman must be masked in whitelist mode');
assert.strictEqual(winCYT.document.fonts.check('16px "SimSun"'), false, 'Non-whitelisted SimSun must be masked in whitelist mode');

// Restore to Blacklist mode
driveConfig(winCYT, { fonts: {
  fontMode: 'blacklist',
  allowedFonts: [],
  customFonts: [],
  blockBuiltin: true
} });
assert.strictEqual(winCYT.document.fonts.check('16px "Times New Roman"'), true, 'Times New Roman must be allowed in blacklist mode');
assert.strictEqual(winCYT.document.fonts.check('16px "SimSun"'), false, 'SimSun must be masked in blacklist mode');

// 12. Web Worker & SharedWorker cross-context protection
const worker = new winCYT.Worker('worker.js');
assert.strictEqual(winCYT.Worker.name, 'Worker', 'Worker constructor name must be Worker');
assert.strictEqual(winCYT.Worker.toString(), 'function Worker() { [native code] }', 'Worker toString must look native');
assert.strictEqual(worker instanceof winCYT.Worker, true, 'Worker instance must pass instanceof check');
assert.throws(() => winCYT.Worker('worker.js'), /Failed to construct 'Worker'/, 'Calling Worker without new must throw TypeError');
assert.throws(() => new winCYT.Worker(), /1 argument required/, 'Calling Worker with 0 args must throw TypeError');

const workerBlob = winCYT.URL._created.get(worker.scriptURL);
assert(workerBlob, 'Worker script must be wrapped in a blob URL');
assert(!workerBlob.content.includes('chosenConcurrency'), 'Worker bootstrap must NOT pin hardwareConcurrency (native on all realms: SharedWorker consistency)');
assert(!workerBlob.content.includes("'deviceMemory'"), 'Worker bootstrap must NOT pin deviceMemory (native on all realms)');
assert(!workerBlob.content.includes('Linux x86_64'), 'Worker bootstrap must NOT spoof a platform persona (native passthrough)');
assert(!/navigator\.(language|platform|userAgent)/.test(workerBlob.content), 'Worker bootstrap must NOT spoof UA-family values (native passthrough)');
// Cross-context GPU consistency: the worker bootstrap interpolates the same
// pooled profile the main thread serves for this host — a worker reporting a
// different renderer than its page is itself a detection signal.
assert(workerBlob.content.includes(expectedGpuCYT.renderer), 'Worker bootstrap must shadow the same pooled GPU renderer as the main thread');
const workerRendererMatch = /if \(pname === 37446\) return '([^']*)';/.exec(workerBlob.content);
assert(workerRendererMatch, 'Worker bootstrap must hook WebGL UNMASKED_RENDERER_WEBGL');
assert.strictEqual(workerRendererMatch[1], gl.getParameter(37446), 'Worker renderer must be byte-identical to the main-thread renderer (cross-context consistency)');
// WebGPU: the worker bootstrap must mask navigator.gpu adapter.info with the
// same interpolated persona (vendor/architecture/device/description) the main
// thread serves — an unmasked worker-side adapter would contradict the page.
assert(workerBlob.content.includes('requestAdapter'), 'Worker bootstrap must hook navigator.gpu requestAdapter (WebGPU)');
assert(workerBlob.content.includes("vendor: 'intel'"), 'Worker bootstrap must spoof the WebGPU vendor token to intel');
assert(workerBlob.content.includes("device: ''") && workerBlob.content.includes("description: ''"), 'Worker bootstrap must blank WebGPU device/description');
assert(workerBlob.content.includes('GPUAdapterInfo'), 'Worker bootstrap must shape the spoofed adapter info like GPUAdapterInfo');
const workerArchMatch = /architecture: '([^']*)'/.exec(workerBlob.content);
assert(workerArchMatch, 'Worker bootstrap must interpolate a WebGPU architecture');
assert.strictEqual(workerArchMatch[1], expectedGpuCYT.wgpuArch, 'Worker WebGPU architecture must match the pooled profile of the main thread');
const workerPoolEntry = GPU_PROFILES_REF.find(p => p.renderer === workerRendererMatch[1]);
assert(workerPoolEntry, 'Worker renderer must come from the GPU profile pool');
assert.strictEqual(workerArchMatch[1], workerPoolEntry.wgpuArch, 'Worker WebGPU architecture must pair with the worker WebGL renderer from the same pool entry');
assert(workerBlob.content.includes('DateTimeFormat'), 'Worker bootstrap must spoof Intl.DateTimeFormat timezone');
assert(workerBlob.content.includes('getTimezoneOffset'), 'Worker bootstrap must spoof Date timezone offset');

const sharedWorker = new winCYT.SharedWorker('shared_worker.js');
assert.strictEqual(winCYT.SharedWorker.name, 'SharedWorker', 'SharedWorker constructor name must be SharedWorker');
assert.strictEqual(winCYT.SharedWorker.toString(), 'function SharedWorker() { [native code] }', 'SharedWorker toString must look native');
assert.strictEqual(sharedWorker instanceof winCYT.SharedWorker, true, 'SharedWorker instance must pass instanceof check');
assert.throws(() => winCYT.SharedWorker('shared_worker.js'), /Failed to construct 'SharedWorker'/, 'Calling SharedWorker without new must throw TypeError');
assert.throws(() => new winCYT.SharedWorker(), /1 argument required/, 'Calling SharedWorker with 0 args must throw TypeError');

// SharedWorker construction must stay fully unwrapped (blob wrapping would
// break cross-tab worker sharing): the script URL passes through verbatim
// and no blob URL is minted for it — contrast with Worker above, which is
// blob-wrapped while the shield is on.
assert.strictEqual(sharedWorker.scriptURL, 'shared_worker.js', 'SharedWorker scriptURL must be the URL exactly as passed in (never blob-wrapped)');
const blobCountBeforeShared = winCYT.URL._created.size;
const sharedWorkerAbs = new winCYT.SharedWorker('https://cdn.example.com/lib/shared-worker.js', { name: 'sw' });
assert.strictEqual(sharedWorkerAbs.scriptURL, 'https://cdn.example.com/lib/shared-worker.js', 'SharedWorker scriptURL must be passed through untouched (absolute URL, options preserved)');
assert.strictEqual(winCYT.URL._created.size, blobCountBeforeShared, 'SharedWorker construction must not mint a blob URL');

console.log('✓ Font fingerprinting probes (Canvas, DOM, Range, SVG, fonts.check/load) cleanly masked.');
console.log('✓ Web Worker and SharedWorker cross-context protections verified.\n');

console.log('Testing Multi-Realm Iframe Protection...');
const iframe = new winCYT.HTMLIFrameElement();
const childWin = iframe.contentWindow;
assert.strictEqual(childWin.navigator.webdriver, false, 'Child iframe navigator.webdriver must be false');
assert.strictEqual(childWin.navigator.language, 'zh-CN', 'Child iframe navigator.language must pass through natively');
assert.strictEqual(new childWin.Intl.DateTimeFormat().resolvedOptions().timeZone, 'America/Los_Angeles', 'Child iframe must inherit IP timezone');
assert.strictEqual(childWin.document.fonts.check('12px "SimSun"'), false, 'Child iframe must mask Chinese fonts');
assert(new childWin.WebGLRenderingContext().getParameter(37445), 'Child iframe WebGL must be protected');
console.log('✓ Multi-realm iframe dynamically intercepted and protected.\n');

// 5. Test EFF Cover Your Tracks Multi-Domain Randomization vs Intra-Domain Consistency
console.log('[Test 5] Validating EFF Cover Your Tracks Multi-Domain Randomization & Consistency...');
const winFPS = createMockWindow('firstpartysimulator.net', 'Linux x86_64');
const contextFPS = vm.createContext(winFPS);
vm.runInContext(stealthCode, contextFPS);

// Metric 1: Canvas toDataURL
const canvasCYT1 = new winCYT.HTMLCanvasElement();
const ctxCYT1 = canvasCYT1.getContext('2d');
const urlCYT1 = canvasCYT1.toDataURL();

const canvasCYT2 = new winCYT.HTMLCanvasElement();
const ctxCYT2 = canvasCYT2.getContext('2d');
const urlCYT2 = canvasCYT2.toDataURL();

const canvasFPS = new winFPS.HTMLCanvasElement();
const ctxFPS = canvasFPS.getContext('2d');
const urlFPS = canvasFPS.toDataURL();

assert.strictEqual(urlCYT1, urlCYT2, 'Canvas data URL must be strictly identical within same domain session');
assert.strictEqual(urlCYT1, expectedFarbledCanvasUrl('coveryourtracks.eff.org'), 'Canvas farbling must match the djb2-derived expected value (deterministic salt)');
assert.strictEqual(urlFPS, expectedFarbledCanvasUrl('firstpartysimulator.net'), 'Canvas farbling must match the djb2-derived expected value on the FPS domain');
assert.notStrictEqual(urlCYT1, urlFPS, 'Canvas data URL must diverge across different domains');

// Scheme B (global farbling): normal sites (browserleaks.com) are farbled too —
// canvas/WebGL/audio/plugin perturbation is now shield-wide, gated only by
// isShieldActive, with per-domain random salt (stable in-site, diverging cross-site).
const winBL = createMockWindow('browserleaks.com', 'Linux x86_64');
vm.runInContext(stealthCode, vm.createContext(winBL));
const canvasBL = new winBL.HTMLCanvasElement();
const ctxBL = canvasBL.getContext('2d');
const urlBL = canvasBL.toDataURL();
assert.strictEqual(urlBL, expectedFarbledCanvasUrl('browserleaks.com'), 'Canvas toDataURL on browserleaks.com must be farbled with the djb2-derived value');
const imgBL = ctxBL.getImageData(0, 0, 1, 1);
assert.notStrictEqual(imgBL.data[0], 100, 'Canvas pixel data on browserleaks.com must be perturbed');

const glBL = new winBL.WebGLRenderingContext();
const pixelsBL = new Uint8Array(4);
glBL.readPixels(0, 0, 1, 1, 0, 0, pixelsBL);
assert.notDeepStrictEqual(Array.from(pixelsBL), [50, 60, 70, 255], 'WebGL readPixels on browserleaks.com must be perturbed (not the native pixels)');

// Audio: stepped samples (every max(1, floor(len/100)) index) are shifted by a
// tiny per-domain delta; non-stepped samples stay byte-identical to native.
const audioBL = new winBL.AudioBuffer();
const chBL = audioBL.getChannelData(0);
const audioBL2 = new winBL.AudioBuffer();
const chBL2 = audioBL2.getChannelData(0);
assert.notStrictEqual(chBL[100], Math.fround(Math.sin(100 / 100)), 'Stepped audio sample on browserleaks.com must be farbled (not the native value)');
assert.strictEqual(chBL[100], chBL2[100], 'Farbled audio must be stable within the same domain visit');
assert.strictEqual(chBL[101], Math.fround(Math.sin(101 / 100)), 'Non-stepped audio samples must remain byte-identical to native data');

// Plugin description passes through untouched: Chrome's built-in plugin
// descriptions are crowd-common constants, so per-site perturbation adds no
// entropy reduction while a replaced getter adds detection surface.
const pluginBL = new winBL.Plugin();
assert.strictEqual(pluginBL.description, 'Portable Document Format', 'Plugin description must pass through unmodified');
console.log('✓ Scheme B: Canvas/WebGL/Audio are farbled on browserleaks.com too.');

// Metric 2: WebGL readPixels
const glCYT = new winCYT.WebGLRenderingContext();
const pixelsCYT1 = new Uint8Array(4);
glCYT.readPixels(0, 0, 1, 1, 0, 0, pixelsCYT1);

const pixelsCYT2 = new Uint8Array(4);
glCYT.readPixels(0, 0, 1, 1, 0, 0, pixelsCYT2);

const glFPS = new winFPS.WebGLRenderingContext();
const pixelsFPS = new Uint8Array(4);
glFPS.readPixels(0, 0, 1, 1, 0, 0, pixelsFPS);

assert.deepStrictEqual(pixelsCYT1, pixelsCYT2, 'WebGL pixels must be strictly identical within same domain');
assert.deepStrictEqual(Array.from(pixelsCYT1), expectedFarbledWebglPixels('coveryourtracks.eff.org'), 'WebGL farbling must match the djb2-derived expected pixels');
assert.deepStrictEqual(Array.from(pixelsFPS), expectedFarbledWebglPixels('firstpartysimulator.net'), 'WebGL farbling must match the expected pixels on the FPS domain');
assert.notDeepStrictEqual(pixelsCYT1, pixelsFPS, 'WebGL pixels must diverge across different domains');
console.log('✓ WebGL readPixels: Stable within domain, randomized across domains (deterministic salt).');

// Metric 3: AudioBuffer
const audioCYT1 = new winCYT.AudioBuffer();
const audioCYT2 = new winCYT.AudioBuffer();
const audioFPS = new winFPS.AudioBuffer();

const chCYT1 = audioCYT1.getChannelData(0);
const chCYT2 = audioCYT2.getChannelData(0);
const chFPS = audioFPS.getChannelData(0);

assert.strictEqual(chCYT1[100], chCYT2[100], 'Audio samples must be strictly identical within same domain');
assert.strictEqual(chCYT1[100], Math.fround(Math.fround(Math.sin(100 / 100)) + expectedAudioDelta('coveryourtracks.eff.org')), 'Audio farbling must match the djb2-derived expected delta');
assert.strictEqual(chFPS[100], Math.fround(Math.fround(Math.sin(100 / 100)) + expectedAudioDelta('firstpartysimulator.net')), 'Audio farbling must match the expected delta on the FPS domain');
assert.notStrictEqual(chCYT1[100], chFPS[100], 'Audio samples must diverge across different domains');
console.log('✓ Audio: Stable within domain, randomized across domains (deterministic salt).');

// Metric 4: Hardware Concurrency — constant 8 on every domain (low-entropy
// value: degrading beats diverging; divergence only pays for seed-farbled vectors).
const concCYT = winCYT.navigator.hardwareConcurrency;
const concFPS = winFPS.navigator.hardwareConcurrency;
assert.strictEqual(concCYT, 16, 'Hardware concurrency must pass through natively (SharedWorker consistency)');
assert.strictEqual(concFPS, 16, 'Hardware concurrency must pass through natively on all sites');
console.log(`✓ Hardware Concurrency: CYT=${concCYT}, FPS=${concFPS} (native passthrough).`);

// Metric 5: Plugins Description — native passthrough (crowd-common constant;
// per-site perturbation would only add a replaced getter).
const pluginCYT = new winCYT.Plugin();
const pluginFPS = new winFPS.Plugin();
assert.strictEqual(pluginCYT.description, pluginFPS.description, 'Plugin description must pass through identically across domains');
console.log(`✓ Plugins: description stays native ("${pluginCYT.description}").\n`);

// 6. Test Edge Cases & Advanced Evasions
console.log('[Test 6] Validating Edge Cases & Advanced Evasions...');

// Legacy createOffer callback
const winLegacy = createMockWindow('legacy-test.com');
vm.runInContext(stealthCode, vm.createContext(winLegacy));
const pcLegacy = new winLegacy.RTCPeerConnection();
let legacyOfferReceived = null;
pcLegacy.createOffer((offer) => {
  legacyOfferReceived = offer;
}).then(() => {
  assert(legacyOfferReceived && legacyOfferReceived.sdp.includes('a=candidate:1 1 UDP 2122260223 0.0.0.0 54321 typ host generation 0'), 'Legacy createOffer callback must receive sanitized SDP (private address -> 0.0.0.0)');
  console.log('✓ Legacy createOffer callback receives sanitized SDP.');
});

// Legacy createAnswer callback
let legacyAnswerReceived = null;
pcLegacy.createAnswer((answer) => {
  legacyAnswerReceived = answer;
}).then(() => {
  assert(legacyAnswerReceived && legacyAnswerReceived.sdp.includes('a=candidate:2 1 UDP 2122260223 0.0.0.0 54321 typ host generation 0'), 'Legacy createAnswer callback must receive sanitized SDP');
  console.log('✓ Legacy createAnswer callback receives sanitized SDP.');
});

// Non-promise createOffer invocation robustness
const winNonPromise = createMockWindow('nonpromise-test.com');
winNonPromise.RTCPeerConnection.prototype.createOffer = function() {
  return undefined;
};
vm.runInContext(stealthCode, vm.createContext(winNonPromise));
const pcNonPromise = new winNonPromise.RTCPeerConnection();
assert.strictEqual(pcNonPromise.createOffer(), undefined, 'createOffer must safely handle non-promise / undefined returns');

// WebGL renderer spoofing (pooled Intel/Mesa persona on every Linux realm)
const winMac = createMockWindow('mac-test.com', 'Linux x86_64');
vm.runInContext(stealthCode, vm.createContext(winMac));
const glMac = new winMac.WebGLRenderingContext();
const expectedGpuMac = expectedGpuProfile('mac-test.com');
assert(GPU_PROFILES_REF.map(p => p.renderer).includes(glMac.getParameter(37446)), 'Linux platform must draw its WebGL renderer from the GPU profile pool');
assert.strictEqual(glMac.getParameter(37446), expectedGpuMac.renderer, 'Linux platform renderer must be the pool entry selected by djb2(eTLD+1) % 5');
console.log('✓ WebGL correctly provides the pooled Linux Intel renderer persona.');

// Cross-frame GPU consistency: two frames of the same site (a.example.com and
// b.example.com) are independent engine instances, each with its own per-load
// salt, yet must report the same GPU renderer — the profile key is the site's
// eTLD+1 (last two host labels) and carries no salt. A salt-derived key would
// make the two frames disagree, which no real GPU ever does.
const winFrameA = createMockWindow('a.example.com', 'Linux x86_64');
vm.runInContext(stealthCode, vm.createContext(winFrameA));
const winFrameB = createMockWindow('b.example.com', 'Linux x86_64');
// Different per-load salt in the second frame: same-site agreement must survive it.
winFrameB.crypto = {
  getRandomValues(arr) {
    for (let i = 0; i < arr.length; i++) arr[i] = (TEST_SESSION_SALT + 12345 + i * 2654435761) >>> 0;
    return arr;
  }
};
vm.runInContext(stealthCode, vm.createContext(winFrameB));
const frameRendererA = new winFrameA.WebGLRenderingContext().getParameter(37446);
const frameRendererB = new winFrameB.WebGLRenderingContext().getParameter(37446);
assert.strictEqual(frameRendererA, frameRendererB, 'Same-site frames (a.example.com / b.example.com) must report an identical GPU renderer despite independent per-load salts');
assert.strictEqual(frameRendererA, expectedGpuProfile('a.example.com').renderer, 'Same-site frame renderer must be the pool entry selected by djb2(eTLD+1) % 5');
console.log('✓ Same-site frames agree on the GPU persona (salt-independent eTLD+1 derivation).');

// Plugin description passes through natively in every frame: no salt, no
// host derivation, no replaced getter. (The old host-derived space padding
// was removed: Chrome's built-in descriptions are crowd-common constants.)
const winPlugA = createMockWindow('a.example.com', 'Linux x86_64');
vm.runInContext(stealthCode, vm.createContext(winPlugA));
const winPlugB = createMockWindow('b.example.com', 'Linux x86_64');
// Different per-load salt in the second frame: passthrough must be unaffected.
winPlugB.crypto = {
  getRandomValues(arr) {
    for (let i = 0; i < arr.length; i++) arr[i] = (TEST_SESSION_SALT + 98765 + i * 2654435761) >>> 0;
    return arr;
  }
};
vm.runInContext(stealthCode, vm.createContext(winPlugB));
const plugDescA = new winPlugA.Plugin().description;
const plugDescB = new winPlugB.Plugin().description;
assert.strictEqual(plugDescA, plugDescB, 'Same-site frames must report the same native Plugin description');
assert.strictEqual(plugDescA, 'Portable Document Format', 'Plugin description must stay byte-identical to native');
console.log('✓ Plugin description stays native in same-site frames.');

// Transparent Canvas toDataURL and toBlob non-clamping farbling
const canvasZero = new winCYT.HTMLCanvasElement();
const ctxZero = canvasZero.getContext('2d');
for (let i = 0; i < ctxZero._pixels.length; i++) ctxZero._pixels[i] = 0; // Pure transparent black
const dataUrlZero = canvasZero.toDataURL();
assert(!dataUrlZero.includes('mockPngR0A0'), 'Canvas toDataURL must mutate even on pure transparent pixels');
assert.strictEqual(ctxZero._pixels[0], 0, 'Canvas pixel data must be restored after toDataURL');
assert.strictEqual(ctxZero._pixels[3], 0, 'Canvas alpha channel must be restored after toDataURL');

canvasZero.toBlob((blob) => {
  assert(blob.r !== 0 || blob.a !== 0, 'Canvas toBlob must mutate transparent pixels');
});
console.log('✓ Canvas toDataURL and toBlob safely farbles and restores pure transparent pixels.');

// Element getClientRects integrity
const elRects = new winCYT.Element();
const clientRects = elRects.getClientRects();
assert(Array.isArray(clientRects) && clientRects.length > 0, 'getClientRects must return array of rects');
console.log('✓ getClientRects returns consistent rect collection.\n');

// 7. Test APIVoid & BotDetector Anti-Fingerprinting Defenses
console.log('[Test 7] Validating BotDetector & APIVoid Anti-Fingerprinting Defenses...');
const winBot = createMockWindow('apivoid.com', 'Linux x86_64');
vm.runInContext(stealthCode, vm.createContext(winBot));

// 7.1 WebGPU Adapter Spoofing (real Linux Chrome values for an Intel iGPU:
// short vendor token, Chrome's architecture spelling, empty device/description).
// The architecture is paired with the WebGL renderer of the same pool entry:
// both are read from the GPU_PROFILES item selected for this host.
const expectedGpuBot = expectedGpuProfile('apivoid.com');
winBot.navigator.gpu.requestAdapter().then(adapter => {
  assert(adapter && adapter.info, 'WebGPU adapter must have info');
  assert.strictEqual(adapter.info.vendor, 'intel', 'WebGPU vendor must be spoofed to intel');
  assert.strictEqual(adapter.info.architecture, expectedGpuBot.wgpuArch, 'WebGPU architecture must be the arch paired with the pooled renderer for this host');
  assert.strictEqual(adapter.info.device, '', 'WebGPU device must be empty for the Intel persona');
  assert.strictEqual(adapter.info.description, '', 'WebGPU description must be empty for the Intel persona');

  adapter.requestAdapterInfo().then(async info => {
    assert.strictEqual(info.vendor, 'intel', 'WebGPU requestAdapterInfo must return the Intel persona vendor');
    assert.strictEqual(info.architecture, expectedGpuBot.wgpuArch, 'WebGPU requestAdapterInfo must return the paired pooled architecture');
    console.log('✓ WebGPU adapter correctly spoofed with the pooled Intel persona.');

    // 7.2 WebGL Standard Parameters
    const gl = new winBot.WebGLRenderingContext();
    assert.strictEqual(gl.getParameter(0x1F00), 'WebKit', 'gl.VENDOR must be WebKit');
    assert.strictEqual(gl.getParameter(0x1F01), 'WebKit WebGL', 'gl.RENDERER must be WebKit WebGL');
    // Cross-API pairing: the WebGL unmasked renderer must be the renderer of
    // the very pool entry whose architecture WebGPU reports above.
    assert.strictEqual(gl.getParameter(37446), expectedGpuBot.renderer, 'WebGL renderer must be the pooled entry paired with the reported WebGPU architecture');
    assert.strictEqual(gl.getParameter(0x8B8C), 'WebGL GLSL ES 1.0 (OpenGL ES GLSL ES 1.0 Chromium)', 'gl.SHADING_LANGUAGE_VERSION must be standard Chrome');
    console.log('✓ WebGL standard parameters (VENDOR, RENDERER, SHADING_LANGUAGE_VERSION) verified.');

    // 7.3 Screen profile spoof (1920x1080 / avail 1920x1040 / 24-bit / dpr 1)
    assert.strictEqual(winBot.screen.width, 1920, 'screen.width must report the spoofed 1920 profile');
    assert.strictEqual(winBot.screen.height, 1080, 'screen.height must report the spoofed 1080 profile');
    assert.strictEqual(winBot.screen.availHeight, 1040, 'availHeight must report the spoofed 1040 (taskbar-adjusted) profile');
    assert.strictEqual(winBot.screen.availWidth, 1920, 'availWidth must report the spoofed 1920 profile');
    assert.strictEqual(winBot.screen.colorDepth, 24, 'colorDepth must report 24');
    assert.strictEqual(winBot.screen.pixelDepth, 24, 'pixelDepth must report 24');
    assert.strictEqual(winBot.devicePixelRatio, 1, 'devicePixelRatio must align with the spoofed screen profile (1)');
    console.log('✓ Screen geometry + devicePixelRatio spoof verified.');

    // 7.5 Worker & SharedWorker Message Pass-through
    // The message rewriter (sanitizeWorkerData/attachMessageSanitizer) was
    // removed with the persona machinery: worker messages now arrive exactly
    // as sent (native passthrough) — no cross-realm rewriting at all.
    const worker = new winBot.Worker('dummy.js');
    let onmessageReceived = null;
    worker.onmessage = (ev) => {
      onmessageReceived = ev.data;
    };
    const workerPayload = {
      userAgent: 'Linux Mozilla/5.0 ...',
      platform: 'Linux x86_64',
      hardwareConcurrency: 16,
      language: 'zh-CN',
      languages: ['zh-CN', 'zh'],
      uaDataPlatform: 'Linux',
      highEntropy: { architecture: 'arm', bitness: '32', platformVersion: '6.5.0' },
      webglVendor: 'Mesa',
      webglRenderer: 'Mesa DRI Intel(R) UHD Graphics',
      fontsBits: '000000000000000'
    };
    worker.dispatchEvent({ type: 'message', data: workerPayload });
    assert(onmessageReceived, 'Worker onmessage must be called');
    assert.deepStrictEqual(onmessageReceived, workerPayload, 'Worker messages must pass through unmodified (no message rewriter)');
    assert.strictEqual(onmessageReceived.hardwareConcurrency, 16, 'Worker message payloads must NOT be rewritten (worker-side hooks live in the bootstrap only)');
    console.log('✓ Worker messages pass through natively (message rewriter removed with personas).');

    // 7.6 Proactive DOM insertion hooks for iframes
    const frame = new winBot.HTMLIFrameElement();
    winBot.document.body.appendChild(frame);
    assert.strictEqual(frame.contentWindow.navigator.platform, 'Linux x86_64', 'Iframe inserted via appendChild must be immediately protected');
    console.log('✓ Proactive DOM insertion hooks protect iframes upon appendChild/insertBefore.\n');

    // 8. CreepJS 0 Lies & Anti-Fingerprinting Defenses
    console.log('[Test 8] Validating CreepJS 0 Lies & Anti-Fingerprinting Defenses...');

    // 8.1 Navigator Prototype Getter Receiver & Descriptor Integrity
    // Persona getters (platform/userAgent/language) are gone, and hardware
    // values (hardwareConcurrency/deviceMemory) are native now (SharedWorker
    // consistency): only the remaining hooked getters are checked here.
    assert.throws(() => winBot.Navigator.prototype.webdriver, /Illegal invocation/, 'Navigator.prototype.webdriver must throw TypeError on prototype');
    assert.strictEqual(winBot.navigator.platform, 'Linux x86_64', 'navigator.platform instance access must return the native value');
    assert.strictEqual(Object.prototype.hasOwnProperty.call(winBot.navigator, 'platform'), true, 'native own platform property must be preserved (no persona getter)');
    assert.strictEqual(Object.prototype.hasOwnProperty.call(winBot.navigator, 'userAgent'), true, 'native own userAgent property must be preserved (no persona getter)');
    assert.strictEqual(Object.prototype.hasOwnProperty.call(winBot.navigator, 'webdriver'), false, 'navigator must not have own webdriver property (engine installs prototype getter)');

    // 8.2 Screen Prototype Getter Receiver & Descriptor Integrity
    assert.throws(() => winBot.Screen.prototype.availHeight, /Illegal invocation/, 'Screen.prototype.availHeight must throw TypeError on prototype');
    assert.strictEqual(Object.prototype.hasOwnProperty.call(winBot.screen, 'availHeight'), false, 'screen must not have own availHeight property');

    // 8.3 HTMLIFrameElement Prototype Getter Receiver Integrity
    assert.throws(() => winBot.HTMLIFrameElement.prototype.contentWindow, /Illegal invocation/, 'HTMLIFrameElement.prototype.contentWindow must throw TypeError on prototype');
    assert.throws(() => winBot.HTMLIFrameElement.prototype.contentDocument, /Illegal invocation/, 'HTMLIFrameElement.prototype.contentDocument must throw TypeError on prototype');

    // 8.4 Intl.DateTimeFormat Prototype resolvedOptions Receiver Integrity
    assert.throws(() => winBot.Intl.DateTimeFormat.prototype.resolvedOptions(), /TypeError/, 'Intl.DateTimeFormat.prototype.resolvedOptions must throw TypeError on prototype');

    // 8.4b Non-constructible CreepJS checks: hooked Date methods and Node methods must not be constructible
    // 'failed call interface error', 'failed new instance error', 'failed class extends error'
    const getTZO = winBot.Date.prototype.getTimezoneOffset;
    assert.throws(() => new getTZO(), /TypeError/, 'Date.prototype.getTimezoneOffset must not be constructible (failed new instance error)');
    assert.strictEqual('prototype' in getTZO, false, 'Date.prototype.getTimezoneOffset must have no .prototype (failed "prototype" in function)');
    const getDStr = winBot.Date.prototype.toString;
    assert.throws(() => new getDStr(), /TypeError/, 'Date.prototype.toString must not be constructible');
    const appendChild = winBot.Node.prototype.appendChild;
    assert.throws(() => new appendChild(), /TypeError/, 'Node.prototype.appendChild must not be constructible');
    assert.strictEqual('prototype' in appendChild, false, 'Node.prototype.appendChild must have no .prototype');

    // 8.5 Function.prototype.toString Error Stack Cleanliness (Blink native emulation)
    const platGetter = Object.getOwnPropertyDescriptor(winBot.Navigator.prototype, 'webdriver').get;
    try {
      Object.create(platGetter).toString();
      assert.fail('Object.create(apiFunction).toString() should throw');
    } catch (err) {
      assert(err instanceof TypeError, 'Must throw TypeError');
      const line1 = err.stack.split('\n')[1];
      assert(/at Function\.toString /.test(line1), `Stack line 1 must match AT_FUNCTION, got: ${line1}`);
    }
    try {
      Object.create(new Proxy(platGetter, {})).toString();
      assert.fail('Object.create(new Proxy).toString() should throw');
    } catch (err) {
      assert(err instanceof TypeError, 'Must throw TypeError');
      const line1 = err.stack.split('\n')[1];
      assert(/at Object\.toString/.test(line1), `Stack line 1 must match AT_OBJECT, got: ${line1}`);
    }

    // 8.6 CreepJS FontFace.load & fonts.check Chinese font masking
    const simsunFF = new winBot.FontFace('SimSun', 'local("SimSun")');
    simsunFF.load().then(() => {
      assert.fail('SimSun font load should reject on privacy profile');
    }).catch(err => {
      assert(err, 'Chinese font SimSun must reject');
    });
    assert.strictEqual(winBot.document.fonts.check('12px "SimSun"'), false, 'Chinese font SimSun must return false in check');
    assert.strictEqual(winBot.document.fonts.check('16px "Arial"'), true, 'Standard font Arial must return true in check');

    // 8.7 CreepJS Worker Data Pass-through (message rewriter removed)
    const creepWorkerPayload = {
      lied: 1,
      lies: { proto: { platform: ['failed illegal error'] } },
      platform: 'Linux x86_64',
      userAgent: 'Mozilla/5.0 (X11; Linux x86_64)...',
      locale: 'zh-CN',
      languages: 'zh-CN,zh',
      timezoneLocation: 'Asia/Shanghai',
      userAgentData: {
        platform: 'Linux',
        platformVersion: '6.5.0',
        uaFullVersion: '120.0.0.0'
      }
    };
    const worker2 = new winBot.Worker('creep.js');
    let creepWorkerMsg = null;
    worker2.onmessage = (ev) => {
      creepWorkerMsg = ev.data;
    };
    worker2.dispatchEvent({ type: 'message', data: creepWorkerPayload });
    assert.deepStrictEqual(creepWorkerMsg, creepWorkerPayload, 'Worker messages must arrive byte-identical (no rewriter: personas removed)');
    assert.strictEqual(creepWorkerMsg.lied, 1, 'Worker lied flag must pass through untouched');
    assert.strictEqual(creepWorkerMsg.locale, 'zh-CN', 'Worker locale must pass through natively');

    // 8.8 Canvas 2D Farbling is now global (entropy reduction): non-CYT domains
    // are farbled too, stable in-site.
    const canvasProbe = new winBot.HTMLCanvasElement();
    const ctxProbe = canvasProbe.getContext('2d');
    ctxProbe._pixels.set([255,255,255,255, 191,191,191,255, 223,223,223,255, 64,64,64,255]);
    const probeRes = ctxProbe.getImageData(0, 0, 2, 2);
    assert.notStrictEqual(probeRes.data[0], 255, 'Canvas pixels must be farbled on non-CYT domains (global farbling)');
    const probeRes2 = ctxProbe.getImageData(0, 0, 2, 2);
    assert.deepStrictEqual(probeRes2.data, probeRes.data, 'Canvas farbling must be stable (idempotent) within the domain');

    // 8.9 Native AudioBuffer Preservation & Idempotency on Non-CYT Domains
    const audioBufferA = new winBot.AudioBuffer(5000);
    const chDataA = audioBufferA.getChannelData(0);
    const chDataA2 = audioBufferA.getChannelData(0);
    assert.strictEqual(chDataA, chDataA2, 'Repeated getChannelData calls must return same buffer');

    console.log('✓ CreepJS 0 lies, descriptor integrity, error stack, font verification, worker passthrough & global canvas farbling passed.\n');

    // 9. Validating Dynamic Toggle Controls & Whitelist Bypass
    console.log('[Test 9] Validating Dynamic Toggle Controls & Whitelist Bypass...');

    // 9.1 Global Master Switch (globalShieldEnabled)
    const winToggle = createMockWindow('coveryourtracks.eff.org', 'Linux x86_64');
    vm.runInContext(stealthCode, vm.createContext(winToggle));

    // Initially active: WebRTC SDP is sanitized, Canvas is farbled, Audio is farbled, Language is en-US
    const pcTogInit = new winToggle.RTCPeerConnection();
    const offerInit = await pcTogInit.createOffer();
    assert(offerInit.sdp.includes('a=candidate:1 1 UDP 2122260223 0.0.0.0 54321 typ host generation 0'), 'Initially, WebRTC SDP must be sanitized');

    const canvasTogInit = new winToggle.HTMLCanvasElement();
    const ctxTogInit = canvasTogInit.getContext('2d');
    for (let i = 0; i < ctxTogInit._pixels.length; i++) ctxTogInit._pixels[i] = 0;
    const dataUrlInit = canvasTogInit.toDataURL();
    assert(!dataUrlInit.includes('mockPngR0A0'), 'Initially, Canvas toDataURL must farble on CYT domain');

    const audioBufInit = new winToggle.AudioBuffer(500);
    const audioDataInit = audioBufInit.getChannelData(0);
    assert(audioDataInit[0] !== 0, 'Initially, AudioBuffer getChannelData must be farbled on CYT domain');

    // Turn OFF globalShieldEnabled (authenticated CE payload)
    driveConfig(winToggle, { cfg: { globalShieldEnabled: false } });

    // Verify WebRTC retains private IP when global shield is disabled
    const pcTogOff = new winToggle.RTCPeerConnection();
    const offerOff = await pcTogOff.createOffer();
    assert(offerOff.sdp.includes('a=candidate:1 1 UDP 2122260223 192.168.1.100 54321 typ host generation 0'), 'When global shield is disabled, WebRTC SDP must NOT be sanitized');

    // Verify Canvas toDataURL does NOT farble when global shield is disabled
    const canvasTog = new winToggle.HTMLCanvasElement();
    const ctxTog = canvasTog.getContext('2d');
    for (let i = 0; i < ctxTog._pixels.length; i++) ctxTog._pixels[i] = 0;
    const dataUrlOff = canvasTog.toDataURL();
    assert.strictEqual(dataUrlOff, 'data:image/png;base64,mockPngR0A0', 'When global shield is disabled, Canvas toDataURL must not farble');

    // Verify AudioBuffer getChannelData does NOT farble when global shield is disabled
    const audioBufOff = new winToggle.AudioBuffer(500);
    const audioDataOff = audioBufOff.getChannelData(0);
    assert.strictEqual(audioDataOff[0], 0, 'When global shield is disabled, AudioBuffer getChannelData must not farble');

    // Verify WebGL renderer returns native renderer when global shield is disabled
    const glTog = new winToggle.WebGLRenderingContext();
    assert.strictEqual(glTog.getParameter(37446), 'llvmpipe (LLVM 12.0.0, 256 bits)', 'When global shield is disabled, WebGL unmasked renderer must return native string');

    // Worker wrapping is gated on the master switch too: with the shield off,
    // new Worker must keep the literal script URL (no blob bootstrap wrap).
    const workerTogOff = new winToggle.Worker('toggle-off-worker.js');
    assert.strictEqual(workerTogOff.scriptURL, 'toggle-off-worker.js', 'With globalShieldEnabled=false, Worker scriptURL must not be blob-wrapped');
    assert(!String(workerTogOff.scriptURL).startsWith('blob:'), 'Worker script URL must stay the page URL (not a blob: URL) when the shield is off');

    // Re-enable globalShieldEnabled
    driveConfig(winToggle, { cfg: { globalShieldEnabled: true } });

    const pcTogOn = new winToggle.RTCPeerConnection();
    const offerOn = await pcTogOn.createOffer();
    assert(offerOn.sdp.includes('a=candidate:1 1 UDP 2122260223 0.0.0.0 54321 typ host generation 0'), 'When global shield is re-enabled, WebRTC SDP must be sanitized again');
    console.log('✓ Global Master Switch enables and disables all protections dynamically.');

    // 9.2 Per-site Whitelist Bypass (siteBypassList)
    const winBypass = createMockWindow('sub.figma.com', 'Linux x86_64');
    vm.runInContext(stealthCode, vm.createContext(winBypass));

    const winProtected = createMockWindow('app.notion.so', 'Linux x86_64');
    vm.runInContext(stealthCode, vm.createContext(winProtected));

    const bypassConfig = { siteBypassList: ['https://figma.com', '*.canva.com'] };
    driveConfig(winBypass, { cfg: bypassConfig });
    driveConfig(winProtected, { cfg: bypassConfig });

    // sub.figma.com matches figma.com -> bypassed
    const pcBypass = new winBypass.RTCPeerConnection();
    const offerBypass = await pcBypass.createOffer();
    assert(offerBypass.sdp.includes('a=candidate:1 1 UDP 2122260223 192.168.1.100 54321 typ host generation 0'), 'Whitelisted/bypassed site must bypass WebRTC SDP sanitization');

    // app.notion.so does NOT match -> protected
    const pcProtected = new winProtected.RTCPeerConnection();
    const offerProtected = await pcProtected.createOffer();
    assert(offerProtected.sdp.includes('a=candidate:1 1 UDP 2122260223 0.0.0.0 54321 typ host generation 0'), 'Non-bypassed site must remain protected');
    console.log('✓ Per-site whitelist bypass selectively disables spoofing for specified domains and subdomains.');

    // 9.3 Independent Feature Toggles (All 5 Modules)
    const winFeat = createMockWindow('coveryourtracks.eff.org', 'Linux x86_64');
    vm.runInContext(stealthCode, vm.createContext(winFeat));

    // Module 1: webrtcProtection toggle
    driveConfig(winFeat, { cfg: { webrtcProtection: false, canvasProtection: true, hardwareProtection: true, audioProtection: true, timezoneProtection: true } });
    const pcFeat1 = new winFeat.RTCPeerConnection();
    const offerFeat1 = await pcFeat1.createOffer();
    assert(offerFeat1.sdp.includes('a=candidate:1 1 UDP 2122260223 192.168.1.100 54321 typ host generation 0'), 'With webrtcProtection=false, WebRTC SDP must NOT be sanitized');

    // WebRTC enumerateDevices when disabled returns raw device list
    const devicesRaw = await winFeat.navigator.mediaDevices.enumerateDevices();
    assert(devicesRaw.some(d => d.deviceId === 'mic-abc-123'), 'With webrtcProtection=false, enumerateDevices must return real deviceId');

    // WebRTC addEventListener & removeEventListener test
    let receivedCandidate = null;
    const iceListener = (ev) => { receivedCandidate = ev.candidate; };
    pcFeat1.addEventListener('icecandidate', iceListener);
    pcFeat1.dispatchEvent({ type: 'icecandidate', candidate: { candidate: 'candidate:1 1 UDP 2122260223 192.168.1.100 54321 typ host generation 0' } });
    assert(receivedCandidate !== null, 'With webrtcProtection=false, icecandidate listener receives private candidate');
    pcFeat1.removeEventListener('icecandidate', iceListener);
    receivedCandidate = null;
    pcFeat1.dispatchEvent({ type: 'icecandidate', candidate: { candidate: 'candidate:1 1 UDP 2122260223 192.168.1.100 54321 typ host generation 0' } });
    assert.strictEqual(receivedCandidate, null, 'removeEventListener must successfully remove icecandidate listener');

    // Canvas still farbled when only webrtcProtection is disabled
    const canvasFeat1 = new winFeat.HTMLCanvasElement();
    const ctxFeat1 = canvasFeat1.getContext('2d');
    for (let i = 0; i < ctxFeat1._pixels.length; i++) ctxFeat1._pixels[i] = 0;
    const dataUrlFeat1 = canvasFeat1.toDataURL();
    assert(!dataUrlFeat1.includes('mockPngR0A0'), 'With canvasProtection=true, Canvas toDataURL must still be farbled');

    // Module 2: canvasProtection toggle
    driveConfig(winFeat, { cfg: { webrtcProtection: true, canvasProtection: false, hardwareProtection: true, audioProtection: true } });
    const canvasFeat2 = new winFeat.HTMLCanvasElement();
    const ctxFeat2 = canvasFeat2.getContext('2d');
    for (let i = 0; i < ctxFeat2._pixels.length; i++) ctxFeat2._pixels[i] = 0;
    const dataUrlFeat2 = canvasFeat2.toDataURL();
    assert.strictEqual(dataUrlFeat2, 'data:image/png;base64,mockPngR0A0', 'With canvasProtection=false, Canvas toDataURL must not be farbled');

    const imgDataFeat2 = ctxFeat2.getImageData(0, 0, 1, 1);
    assert.strictEqual(imgDataFeat2.data[0], 0, 'With canvasProtection=false, getImageData must return unperturbed pixel');

    // Module 3: audioProtection toggle
    driveConfig(winFeat, { cfg: { audioProtection: false } });
    const audioBufFeat = new winFeat.AudioBuffer(500);
    const audioDataFeat = audioBufFeat.getChannelData(0);
    assert.strictEqual(audioDataFeat[0], 0, 'With audioProtection=false, AudioBuffer getChannelData must not be farbled');

    const destBuf = new Float32Array(500);
    audioBufFeat.copyFromChannel(destBuf, 0);
    assert.strictEqual(destBuf[0], 0, 'With audioProtection=false, copyFromChannel must not be farbled');

    // Module 4: timezoneProtection toggle (timezone only — locale/lang are
    // native passthrough now, personas removed)
    setTestTimezone(winFeat, 'Europe/Paris');
    driveConfig(winFeat, { cfg: { timezoneProtection: false } });
    assert.strictEqual(winFeat.navigator.language, 'zh-CN', 'navigator.language passes through natively (no persona, regardless of toggles)');
    assert(winFeat.navigator.languages.includes('zh-CN'), 'navigator.languages keeps the native entries');

    const dtfFeatDisabled = new winFeat.Intl.DateTimeFormat('zh-CN');
    assert.strictEqual(dtfFeatDisabled.resolvedOptions().locale, 'zh-CN', 'With timezoneProtection=false, Intl.DateTimeFormat allows native zh-CN locale');
    assert.strictEqual(dtfFeatDisabled.resolvedOptions().timeZone, new Intl.DateTimeFormat().resolvedOptions().timeZone, 'With timezoneProtection=false, timezone falls back to the native local zone');

    // Re-enable timezoneProtection: locale stays native, timezone realigns.
    driveConfig(winFeat, { cfg: { timezoneProtection: true } });
    assert.strictEqual(winFeat.navigator.language, 'zh-CN', 'navigator.language stays native even with timezoneProtection=true (personas removed)');
    const dtfFeatEnabled = new winFeat.Intl.DateTimeFormat('zh-CN');
    assert.strictEqual(dtfFeatEnabled.resolvedOptions().locale, 'zh-CN', 'With timezoneProtection=true, zh-CN locale is still passed through natively');
    assert.strictEqual(dtfFeatEnabled.resolvedOptions().timeZone, 'Europe/Paris', 'With timezoneProtection=true, timezone realigns with the exit IP zone');

    // Module 5: hardwareProtection toggle
    driveConfig(winFeat, { cfg: { hardwareProtection: false } });
    const glFeat = new winFeat.WebGLRenderingContext();
    assert.strictEqual(glFeat.getParameter(37446), 'llvmpipe (LLVM 12.0.0, 256 bits)', 'With hardwareProtection=false, WebGL renderer must return native string');
    assert.strictEqual(winFeat.navigator.hardwareConcurrency, 16, 'With hardwareProtection=false, hardwareConcurrency returns native core count');
    assert.strictEqual(winFeat.navigator.deviceMemory, 32, 'With hardwareProtection=false, deviceMemory returns native RAM');
    assert.strictEqual(winFeat.performance.memory.jsHeapSizeLimit, 4294967296, 'With hardwareProtection=false, jsHeapSizeLimit returns native heap size');
    assert.strictEqual(winFeat.screen.availHeight, 1080, 'With hardwareProtection=false, screen spoof is disabled and availHeight returns the native 1080');
    assert.strictEqual(winFeat.devicePixelRatio, 1.25, 'With hardwareProtection=false, devicePixelRatio returns the native 1.25');

    // Module 6: Font protection toggle
    driveConfig(winFeat, { cfg: { fontProtection: false } });
    const allFontsDisabled = await winFeat.queryLocalFonts();
    assert(allFontsDisabled.some(f => f.family === 'SimSun'), 'With fontProtection=false, SimSun must NOT be filtered from queryLocalFonts');

    driveConfig(winFeat, { cfg: { fontProtection: true } });
    const allFontsEnabled = await winFeat.queryLocalFonts();
    assert(!allFontsEnabled.some(f => f.family === 'SimSun'), 'With fontProtection=true, SimSun must be filtered from queryLocalFonts');
    console.log('✓ Independent feature toggles correctly control individual modules.');

    // 9.4 Other Minority Scripts & Symbol Fonts Batch Toggles (blockOtherScripts / blockSymbols)
    const winOther = createMockWindow('fonts-test.com', 'Linux x86_64');
    winOther.queryLocalFonts = function() {
      return Promise.resolve([
        { family: 'Arial', fullName: 'Arial Regular', postscriptName: 'ArialMT' },
        { family: 'Noto Sans Arabic', fullName: 'Noto Sans Arabic Regular', postscriptName: 'NotoSansArabic' },
        { family: 'Amiri', fullName: 'Amiri Regular', postscriptName: 'Amiri-Regular' },
        { family: 'Symbola', fullName: 'Symbola', postscriptName: 'Symbola' },
        { family: 'Noto Sans Symbols 2', fullName: 'Noto Sans Symbols 2', postscriptName: 'NotoSansSymbols2' },
        { family: 'SimSun', fullName: 'SimSun Regular', postscriptName: 'SimSun' }
      ]);
    };
    vm.runInContext(stealthCode, vm.createContext(winOther));

    // Default: both batch toggles are false
    const fontsDefault = await winOther.queryLocalFonts();
    assert(fontsDefault.some(f => f.family === 'Noto Sans Arabic'), 'By default, Noto Sans Arabic must NOT be filtered');
    assert(fontsDefault.some(f => f.family === 'Amiri'), 'By default, Amiri must NOT be filtered');
    assert(fontsDefault.some(f => f.family === 'Symbola'), 'By default, Symbola must NOT be filtered');
    assert(!fontsDefault.some(f => f.family === 'SimSun'), 'SimSun must be filtered by default');

    // Turn ON blockOtherScripts only: scripts are hidden, symbols must NOT be
    driveConfig(winOther, { cfg: { blockOtherScripts: true } });
    const fontsBlocked = await winOther.queryLocalFonts();
    assert(!fontsBlocked.some(f => f.family === 'Noto Sans Arabic'), 'When blockOtherScripts=true, Noto Sans Arabic must be filtered');
    assert(!fontsBlocked.some(f => f.family === 'Amiri'), 'When blockOtherScripts=true, Amiri must be filtered');
    assert(fontsBlocked.some(f => f.family === 'Symbola'), 'Symbols are an independent category: blockOtherScripts must NOT filter Symbola');
    assert(fontsBlocked.some(f => f.family === 'Noto Sans Symbols 2'), 'Symbols are an independent category: blockOtherScripts must NOT filter Noto Sans Symbols 2');
    assert(fontsBlocked.some(f => f.family === 'Arial'), 'Standard Latin font Arial must still be retained');

    // Turn ON blockSymbols: symbol fonts are hidden independently
    driveConfig(winOther, { cfg: { blockSymbols: true } });
    const fontsSymbolsBlocked = await winOther.queryLocalFonts();
    assert(!fontsSymbolsBlocked.some(f => f.family === 'Symbola'), 'When blockSymbols=true, Symbola must be filtered');
    assert(!fontsSymbolsBlocked.some(f => f.family === 'Noto Sans Symbols 2'), 'When blockSymbols=true, Noto Sans Symbols 2 must be filtered');
    assert(fontsSymbolsBlocked.some(f => f.family === 'Arial'), 'Standard Latin font Arial must still be retained');

    // Turn both OFF: everything is restored
    driveConfig(winOther, { cfg: { blockOtherScripts: false, blockSymbols: false } });
    const fontsRestored = await winOther.queryLocalFonts();
    assert(fontsRestored.some(f => f.family === 'Noto Sans Arabic'), 'When blockOtherScripts=false, Noto Sans Arabic must be restored');
    assert(fontsRestored.some(f => f.family === 'Symbola'), 'When blockSymbols=false, Symbola must be restored');
    console.log('✓ Batch minority scripts and symbol toggles filter independently (blockOtherScripts does not hide symbols).\n');

    // 9.5 Geolocation spoof (opt-in): off by default, configured coordinates when enabled
    const winGeo = createMockWindow('geo-test.com', 'Linux x86_64');
    vm.runInContext(stealthCode, vm.createContext(winGeo));
    const readGeo = (win) => new Promise((resolve) => {
      win.navigator.geolocation.getCurrentPosition((pos) => resolve(pos));
    });

    const geoNative = await readGeo(winGeo);
    assert.strictEqual(geoNative.coords.latitude, 1, 'By default geolocation must pass through natively');
    assert.strictEqual(geoNative.coords.longitude, 2, 'By default geolocation must pass through natively');

    driveConfig(winGeo, { geo: { enabled: true, latitude: 35.6762, longitude: 139.6503 } });
    const geoMocked = await readGeo(winGeo);
    assert.strictEqual(geoMocked.coords.latitude, 35.6762, 'When enabled, geolocation must report the configured latitude');
    assert.strictEqual(geoMocked.coords.longitude, 139.6503, 'When enabled, geolocation must report the configured longitude');
    assert.strictEqual(typeof geoMocked.timestamp, 'number', 'Spoofed position must carry a timestamp');

    const watchResult = await new Promise((resolve) => {
      const id = winGeo.navigator.geolocation.watchPosition((pos) => resolve({ id, lat: pos.coords.latitude }));
    });
    assert.strictEqual(watchResult.id, 1, 'watchPosition must return a watcher id when spoofing');
    assert.strictEqual(watchResult.lat, 35.6762, 'watchPosition must report the configured latitude');

    driveConfig(winGeo, { geo: { enabled: false } });
    const geoRestored = await readGeo(winGeo);
    assert.strictEqual(geoRestored.coords.latitude, 1, 'Disabled geolocation must pass through natively again');
    console.log('✓ Geolocation spoof: opt-in coordinates apply to getCurrentPosition/watchPosition and reset cleanly.\n');

    // 10. Regression: v1.0.1 security & correctness fixes
    console.log('[Test 10] Validating Regression: v1.0.1 security & correctness fixes...');

    // 10.1 (S1) Config channel security: forged CE tokens and legacy fixed
    // event names must never change engine configuration.
    {
      const winSec = createMockWindow('security-test.example', 'Linux x86_64');
      vm.runInContext(stealthCode, vm.createContext(winSec));
      const hs = getEngineHandshake(winSec);
      assert(/^__bocchi_evt_[0-9a-f]{8,16}$/.test(hs.e), 'engine handshake must use a random per-frame config event name');
      assert(/^[0-9a-f]{32}$/.test(hs.t), 'engine handshake token must be 16 bytes of hex');

      // Forged payloads: correct CE name but wrong token...
      winSec.document.dispatchEvent({ type: hs.e, detail: { t: '0000000000000000000000000000dead', cfg: { globalShieldEnabled: false, webrtcProtection: false } }, stopImmediatePropagation() {} });
      // ...correct token but a guessed (wrong) event name...
      dispatchUnauthenticated(winSec, '__bocchi_evt_00000000', { t: hs.t, cfg: { globalShieldEnabled: false } });
      // ...and the removed legacy fixed event names.
      dispatchUnauthenticated(winSec, '__bocchi_config_sync__', { globalShieldEnabled: false, webrtcProtection: false });
      dispatchUnauthenticated(winSec, '__bocchi_tz_sync__', { timezone: 'Europe/Berlin' });
      dispatchUnauthenticated(winSec, '__bocchi_fonts_sync__', { customFonts: ['Arial'], allowedFonts: [], blockBuiltin: true });

      // None of the forged payloads may take effect.
      const pcSec = new winSec.RTCPeerConnection();
      const offerSec = await pcSec.createOffer();
      assert(offerSec.sdp.includes('a=candidate:1 1 UDP 2122260223 0.0.0.0 54321 typ host generation 0'),
        'forged config events must not disable WebRTC SDP sanitization');
      assert.strictEqual(new winSec.Intl.DateTimeFormat().resolvedOptions().timeZone, 'America/Los_Angeles',
        'forged __bocchi_tz_sync__ must not change the active timezone');
      assert.strictEqual(winSec.document.fonts.check('16px Arial'), true,
        'forged __bocchi_fonts_sync__ must not hide a standard font');
      assert.strictEqual(winSec.document.fonts.check('12px "SimSun"'), false,
        'SimSun must stay masked after forged font events');

      // Control: the same payload over the authenticated channel DOES work,
      // and after the first valid CE the engine stops re-answering __bocchi_req__.
      const hsBefore = winSec._dispatchedDocEvents.filter(e => e.type === '__bocchi_hs__').length;
      driveConfig(winSec, { tz: 'Europe/Berlin' });
      assert.strictEqual(new winSec.Intl.DateTimeFormat().resolvedOptions().timeZone, 'Europe/Berlin',
        'authenticated CE payload must be able to change the timezone');
      driveConfig(winSec, { cfg: { globalShieldEnabled: false } });
      const pcSecOff = new winSec.RTCPeerConnection();
      const offerSecOff = await pcSecOff.createOffer();
      assert(offerSecOff.sdp.includes('a=candidate:1 1 UDP 2122260223 192.168.1.100 54321 typ host generation 0'),
        'authenticated CE payload must be able to disable the shield');
      winSec.document.dispatchEvent({ type: '__bocchi_req__' });
      const hsAfter = winSec._dispatchedDocEvents.filter(e => e.type === '__bocchi_hs__').length;
      assert.strictEqual(hsAfter, hsBefore, 'after the first authenticated CE, __bocchi_req__ must not re-trigger the handshake (anti-fishing)');
      driveConfig(winSec, { cfg: { globalShieldEnabled: true } });
      console.log('✓ S1: config channel is token-secured; forged/legacy events are ignored.');
    }

    // 10.2 (S3) Array.prototype.includes backdoor removed (native semantics only)
    {
      assert.strictEqual(winCYT.Array.prototype.includes, Array.prototype.includes,
        'Array.prototype.includes must remain the pristine native function (backdoor removed)');
      const arr287 = new Array(287).fill('x');
      arr287[0] = '00b72507';
      assert.strictEqual(arr287.includes('not-present'), false, 'includes backdoor sentinel (287/00b72507) must no longer force true');
      assert.strictEqual(arr287.includes('00b72507'), true, 'native includes must still find real members');
      const arr237 = new Array(237).fill(1);
      arr237[0] = -1056897629;
      assert.strictEqual(arr237.includes('anything'), false, 'includes backdoor sentinel (237/-1056897629) must no longer force true');
      assert.strictEqual(arr237.includes(-1056897629), true, 'native includes must still find real members');
      console.log('✓ S3: Array.prototype.includes backdoor removed.');
    }

    // 10.3 (S6) SDP sanitization is line-based and only rewrites private
    // candidate connection addresses (field 5).
    {
      const winSDP = createMockWindow('sdp-test.example', 'Linux x86_64');
      vm.runInContext(stealthCode, vm.createContext(winSDP));
      const pcSDP = new winSDP.RTCPeerConnection();
      const fingerprintLine = 'a=fingerprint:sha-256 00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF';
      const icePwdLine = 'a=ice-pwd:1/A3jOEqf2wMIPZxOEuUYpLi';
      const iceUfragLine = 'a=ice-ufrag:AbCdEfGh';
      const privLine = 'a=candidate:1 1 UDP 2122260223 192.168.1.100 54321 typ host generation 0';
      const mdnsLine = 'a=candidate:2 1 UDP 2122260223 5f6a1f2e-3e4d-4a5b-9c6d-1a2b3c4d5e6f.local 54321 typ host generation 0';
      const pubLine = 'a=candidate:3 1 UDP 1686052607 203.0.113.1 54321 typ srflx raddr 198.51.100.7 rport 54321';
      const privV6Line = 'a=candidate:4 1 UDP 1686052607 fe80::abcd:1234 54324 typ host generation 0';
      const sdpIn = [
        'v=0',
        'o=- 4611731400430051336 2 IN IP4 127.0.0.1',
        's=-',
        't=0 0',
        fingerprintLine,
        icePwdLine,
        iceUfragLine,
        privLine,
        mdnsLine,
        pubLine,
        privV6Line,
        'a=end-of-candidates'
      ].join('\r\n');
      pcSDP.setLocalDescription(new winSDP.RTCSessionDescription({ type: 'offer', sdp: sdpIn }));
      const outLines = pcSDP.localDescription.sdp.split('\r\n');
      assert(outLines.includes(fingerprintLine), 'a=fingerprint:sha-256 line must be preserved byte-for-byte');
      assert(outLines.includes(icePwdLine), 'a=ice-pwd line must be preserved byte-for-byte');
      assert(outLines.includes(iceUfragLine), 'a=ice-ufrag line must be preserved byte-for-byte');
      assert(outLines.includes(mdnsLine), 'mDNS (.local) candidate line must be preserved untouched');
      assert(outLines.includes(pubLine), 'public srflx candidate line must be preserved untouched');
      assert(outLines.includes('a=candidate:1 1 UDP 2122260223 0.0.0.0 54321 typ host generation 0'),
        'private IPv4 candidate connection address must be replaced with 0.0.0.0 (host line kept, not dropped)');
      assert(!outLines.includes(privLine), 'raw private IPv4 candidate line must not survive');
      assert(outLines.includes('a=candidate:4 1 UDP 1686052607 :: 54324 typ host generation 0'),
        'link-local IPv6 candidate connection address must be replaced with ::');
      assert(!outLines.includes(privV6Line), 'raw link-local IPv6 candidate line must not survive');
      console.log('✓ S6: SDP sanitization preserves fingerprint/ice/mDNS lines and rewrites only private candidate addresses.');
    }

    // 10.4 (S4) AudioBuffer: copyFromChannel and getChannelData share one
    // underlying one-time mutation (no destination delta accumulation).
    {
      const winAudio = createMockWindow('coveryourtracks.eff.org', 'Linux x86_64');
      vm.runInContext(stealthCode, vm.createContext(winAudio));
      const buf = new winAudio.AudioBuffer(5000);
      const d1 = new Float32Array(5000);
      buf.copyFromChannel(d1, 0);
      const d2 = new Float32Array(5000);
      buf.copyFromChannel(d2, 0);
      let copiesConsistent = true;
      for (let i = 0; i < 5000; i++) { if (d1[i] !== d2[i]) { copiesConsistent = false; break; } }
      assert(copiesConsistent, 'two copyFromChannel calls into equivalent destinations must produce identical results (no delta accumulation)');
      const ch = buf.getChannelData(0);
      let matchesGetChannelData = true;
      for (let i = 0; i < 5000; i++) { if (d1[i] !== ch[i]) { matchesGetChannelData = false; break; } }
      assert(matchesGetChannelData, 'copyFromChannel output must match getChannelData exactly');
      const chAgain = buf.getChannelData(0);
      assert.strictEqual(ch, chAgain, 'repeated getChannelData calls must return the same buffer reference');

      // copyFromChannel-first ordering must produce the same model.
      const buf2 = new winAudio.AudioBuffer(5000);
      const d3 = new Float32Array(5000);
      buf2.copyFromChannel(d3, 0);
      const ch2 = buf2.getChannelData(0);
      let copyFirstConsistent = true;
      for (let i = 0; i < 5000; i++) { if (d3[i] !== ch2[i]) { copyFirstConsistent = false; break; } }
      assert(copyFirstConsistent, 'copyFromChannel before getChannelData must stay consistent');
      assert.notStrictEqual(d1[0], 0, 'audio farbling must have perturbed the underlying data');
      console.log('✓ S4: AudioBuffer copyFromChannel/getChannelData are consistent and idempotent.');
    }

    // 10.5 (S5) Overlapping toBlob exports must restore true pixels exactly once.
    {
      const canvasBlob = new winCYT.HTMLCanvasElement();
      const ctxBlob = canvasBlob.getContext('2d');
      for (let i = 0; i < ctxBlob._pixels.length; i++) ctxBlob._pixels[i] = 200;
      const trueR = ctxBlob._pixels[0];
      const trueA = ctxBlob._pixels[3];
      let blob1 = null;
      let blob2 = null;
      canvasBlob.toBlob(b => { blob1 = b; });
      canvasBlob.toBlob(b => { blob2 = b; }); // second export starts before the first callback fires
      await new Promise(resolve => setTimeout(resolve, 20));
      assert(blob1 && blob2, 'both overlapping toBlob callbacks must fire');
      assert.notStrictEqual(blob1.r, trueR, 'first toBlob export must be farbled');
      assert.notStrictEqual(blob2.r, trueR, 'second toBlob export must farble the true value, not stack on the first perturbation');
      assert.strictEqual(ctxBlob._pixels[0], trueR, 'canvas red channel must be restored to the true value after overlapping exports');
      assert.strictEqual(ctxBlob._pixels[3], trueA, 'canvas alpha channel must be restored to the true value after overlapping exports');
      console.log('✓ S5: overlapping toBlob exports restore true pixels without stacked perturbations.');
    }

    // 10.6 (f) Same-window double patching is prevented by shared patch marks.
    {
      const winDP = createMockWindow('coveryourtracks.eff.org', 'Linux x86_64');
      const ctxDP = vm.createContext(winDP);
      vm.runInContext(stealthCode, ctxDP);
      const toDataURLBefore = winDP.HTMLCanvasElement.prototype.toDataURL;
      const getTZOBefore = winDP.Date.prototype.getTimezoneOffset;
      const canvasDP = new winDP.HTMLCanvasElement();
      canvasDP.getContext('2d');
      const urlDP1 = canvasDP.toDataURL();
      assert.notStrictEqual(urlDP1, 'data:image/png;base64,mockPngR100A255', 'control: single patch farbles the CYT canvas');

      // Second engine instance in the same realm (same-origin iframe scenario).
      vm.runInContext(stealthCode, ctxDP);
      assert.strictEqual(winDP.HTMLCanvasElement.prototype.toDataURL, toDataURLBefore, 'second applyStealth must not re-wrap toDataURL (shared patch marks)');
      assert.strictEqual(winDP.Date.prototype.getTimezoneOffset, getTZOBefore, 'second applyStealth must not re-wrap Date hooks');
      const urlDP2 = canvasDP.toDataURL();
      assert.strictEqual(urlDP1, urlDP2, 'toDataURL readback must be unchanged after a second engine load (no double farbling)');
      console.log('✓ Double patching of the same window is prevented (shared patch marks).');
    }

    // 10.7 (g) REMOVED: the worker message rewriter (and its >= 2-field gate)
    // was deleted together with the persona machinery — messages always pass
    // through natively now (see 7.5 / 8.7).

    // 10.8 (h) isCYTDomain uses exact domain matching (observable via the
    // CYT-gated globalPrivacyControl spoof; canvas farbling is domain-global).
    {
      const winEvil = createMockWindow('eff.org.evil.com', 'Linux x86_64');
      delete winEvil.navigator.globalPrivacyControl;
      vm.runInContext(stealthCode, vm.createContext(winEvil));
      assert.strictEqual(winEvil.navigator.globalPrivacyControl, undefined,
        'eff.org.evil.com must NOT be treated as a CYT domain (no GPC spoof)');
      const canvasEvil = new winEvil.HTMLCanvasElement();
      canvasEvil.getContext('2d');
      assert.notStrictEqual(canvasEvil.toDataURL(), 'data:image/png;base64,mockPngR100A255',
        'look-alike host is still farbled (farbling applies to every domain)');

      const winSub = createMockWindow('sub.eff.org', 'Linux x86_64');
      delete winSub.navigator.globalPrivacyControl;
      vm.runInContext(stealthCode, vm.createContext(winSub));
      assert.strictEqual(winSub.navigator.globalPrivacyControl, true,
        'a genuine eff.org subdomain must remain CYT-protected (GPC spoof active)');
      const canvasSub = new winSub.HTMLCanvasElement();
      canvasSub.getContext('2d');
      assert.notStrictEqual(canvasSub.toDataURL(), 'data:image/png;base64,mockPngR100A255',
        'a genuine eff.org subdomain must remain farbled');
      console.log('✓ isCYTDomain exact matching: look-alike hosts get no CYT-only GPC spoof (farbling stays global).');
    }

    // 10.9 Screen spoof guardrail: a real window larger than the profile
    // disables the spoof entirely (never report impossible outerWidth > width),
    // and a real screen smaller than the profile is left untouched (claiming a
    // bigger screen than physically present contradicts matchMedia/rendering —
    // headless VMs land here).
    {
      const winBig = createMockWindow('big-screen.example', 'Linux x86_64');
      winBig.outerWidth = 2560; // wider than the 1920 spoofed profile
      vm.runInContext(stealthCode, vm.createContext(winBig));
      assert.strictEqual(winBig.screen.availHeight, 1080, 'screen spoof must be skipped when the real outerWidth exceeds the profile');
      assert.strictEqual(winBig.devicePixelRatio, 1.25, 'devicePixelRatio must stay native when the guardrail trips');

      const winSmall = createMockWindow('small-screen.example', 'Linux x86_64');
      winSmall.outerWidth = 1280;
      vm.runInContext(stealthCode, vm.createContext(winSmall));
      assert.strictEqual(winSmall.screen.availHeight, 1040, 'screen spoof applies when the real window fits the profile');
      assert.strictEqual(winSmall.devicePixelRatio, 1, 'devicePixelRatio spoof applies when the real window fits the profile');

      const winTiny = createMockWindow('tiny-screen.example', 'Linux x86_64');
      winTiny.screen._native = { width: 800, height: 600, availWidth: 800, availHeight: 600, colorDepth: 24, pixelDepth: 24 };
      winTiny.outerWidth = 780;
      vm.runInContext(stealthCode, vm.createContext(winTiny));
      assert.strictEqual(winTiny.screen.availHeight, 600, 'screen spoof must be skipped when the real screen is smaller than the profile');
      assert.strictEqual(winTiny.screen.width, 800, 'native screen width must pass through on a small real screen');
      assert.strictEqual(winTiny.devicePixelRatio, 1.25, 'devicePixelRatio must stay native on a small real screen');

      // outerHeight dimension of the same guardrail: a maximized window on a
      // tall real screen (2160p) exceeds the 1080 profile height, so the
      // spoof must trip there too and every dimension passes through natively.
      const winTall = createMockWindow('tall-screen.example', 'Linux x86_64');
      winTall.screen._native = { width: 1920, height: 2160, availWidth: 1920, availHeight: 2112, colorDepth: 24, pixelDepth: 24 };
      winTall.outerHeight = 2112; // taller than the 1080 profile
      vm.runInContext(stealthCode, vm.createContext(winTall));
      assert.strictEqual(winTall.screen.height, 2160, 'screen spoof must be skipped when the real outerHeight exceeds the profile height');
      assert.strictEqual(winTall.screen.availHeight, 2112, 'native availHeight must pass through when the outerHeight guardrail trips');
      assert.strictEqual(winTall.devicePixelRatio, 1.25, 'devicePixelRatio must stay native when the outerHeight guardrail trips');
      console.log('✓ Screen spoof guardrail respects the real window geometry.');
    }

    // 10.10 Shared Symbol.for registries removed (pages cannot reach engine
    // internals through the global symbol registry anymore).
    {
      const LEGACY_REGISTRY_KEYS = [
        '__bocchi_native_map__', '__bocchi_protected_windows__', '__bocchi_canvas_ctx_map__',
        '__bocchi_audio_farbled_map__', '__bocchi_audio_calibrated_set__', '__bocchi_window_salt_map__',
        '__bocchi_shield_config__', '__bocchi_font_config__'
      ];
      LEGACY_REGISTRY_KEYS.forEach(key => {
        assert.strictEqual(winCYT[Symbol.for(key)], undefined, 'legacy shared registry ' + key + ' must not exist on window');
      });
      // The one remaining registry symbol (internal patch-dedup mark) holds a
      // WeakMap-shaped map created in the page realm: not enumerable through
      // any page-facing API. (Duck-typed check: cross-realm instanceof fails.)
      const markRegistry = winCYT[Symbol.for('__bpc_pm_7e4b1c92')];
      assert(markRegistry && typeof markRegistry.get === 'function' && typeof markRegistry.set === 'function',
        'the remaining patch-mark registry must stay a WeakMap-shaped internal (non-enumerable internals)');
      assert.strictEqual(winCYT[Symbol.for('__bpc_pm_7e4b1c92')], markRegistry, 'patch-mark registry lookup must be stable');
      console.log('✓ Shared Symbol.for registries removed.');
    }

    // 10.11 navigator.languages native semantics: the engine no longer replaces
    // it with a spoofed frozen singleton — the native array is passed through.
    {
      assert.strictEqual(winCYT.navigator.languages, winCYT.navigator.languages, 'navigator.languages must return the same native array reference on every read');
      assert.deepStrictEqual([...winCYT.navigator.languages], ['zh-CN', 'zh'], 'navigator.languages must keep the native values');
      console.log('✓ navigator.languages native passthrough verified.');
    }

    // 10.12 performance.now() flooring + getGamepads downgrade (entropy
    // reduction, both gated on hardwareProtection).
    {
      assert.strictEqual(winCYT.performance.now(), 123, 'performance.now() must floor 123.456 to 123 while hardwareProtection is on');
      assert.strictEqual(winCYT.performance.memory.jsHeapSizeLimit, 2172649472, 'jsHeapSizeLimit must clamp to 2172649472 while hardwareProtection is on');
      const winPerf = createMockWindow('perf-test.example', 'Linux x86_64');
      vm.runInContext(stealthCode, vm.createContext(winPerf));
      driveConfig(winPerf, { cfg: { hardwareProtection: false } });
      assert.strictEqual(winPerf.performance.now(), 123.456, 'With hardwareProtection=false, performance.now() returns the native value');

      const winGP = createMockWindow('gamepad-test.example', 'Linux x86_64');
      vm.runInContext(stealthCode, vm.createContext(winGP));
      const gpOn1 = winGP.navigator.getGamepads();
      const gpOn2 = winGP.navigator.getGamepads();
      assert.strictEqual(gpOn1.length, 0, 'getGamepads must return [] while hardwareProtection is on');
      assert.notStrictEqual(gpOn1, gpOn2, 'getGamepads must return a fresh array on every call');
      driveConfig(winGP, { cfg: { hardwareProtection: false } });
      const gpOff = winGP.navigator.getGamepads();
      assert.strictEqual(gpOff.length, 1, 'With hardwareProtection=false, getGamepads returns the native list');
      assert(gpOff[0].id.includes('Xbox 360'), 'native gamepad entries must pass through when the toggle is off');
      console.log('✓ performance.now() flooring and getGamepads downgrade verified.');
    }

    console.log('✓ Regression suite (v1.0.1 fixes) fully passed.\n');

    // 11. Regression: OffscreenCanvas coverage
    console.log('[Test 11] Validating OffscreenCanvas coverage...');
    {
      // 11.1 OffscreenCanvas on a CYT domain: exports farble like toDataURL.
      const winOC = createMockWindow('coveryourtracks.eff.org', 'Linux x86_64');
      vm.runInContext(stealthCode, vm.createContext(winOC));

      const oc = new winOC.OffscreenCanvas(300, 150);
      const octx = oc.getContext('2d');
      assert(octx, 'mock offscreen 2d context must be created');
      const blob = await oc.convertToBlob();
      assert.notStrictEqual(blob.r, 100, 'convertToBlob on CYT must export a farbled pixel');
      assert.strictEqual(octx._pixels[0], 100, 'convertToBlob must restore the true pixel after export');

      // Overlapping convertToBlob calls: both blobs farble from the TRUE value
      // and the canvas ends restored (no stacked perturbations).
      const oc2 = new winOC.OffscreenCanvas(300, 150);
      const octx2 = oc2.getContext('2d');
      const [b1, b2] = await Promise.all([oc2.convertToBlob(), oc2.convertToBlob()]);
      assert.notStrictEqual(b1.r, 100, 'first overlapping convertToBlob must be farbled');
      assert.notStrictEqual(b2.r, 100, 'second overlapping convertToBlob must be farbled');
      assert.strictEqual(b1.r, b2.r, 'overlapping exports must farble from the same true pixel');
      assert.strictEqual(octx2._pixels[0], 100, 'canvas must be restored to the true pixel after overlapping exports');

      // transferToImageBitmap: the bitmap carries the farbled pixel and the
      // canvas bitmap is cleared (native post-transfer state, no restore write).
      const oc3 = new winOC.OffscreenCanvas(300, 150);
      const octx3 = oc3.getContext('2d');
      const bm = oc3.transferToImageBitmap();
      assert.notStrictEqual(bm.r, 100, 'transferToImageBitmap on CYT must carry a farbled pixel');
      assert.strictEqual(octx3._pixels[0], 0, 'source canvas must be left blank after transfer (native reset)');

      // measureText on OffscreenCanvasRenderingContext2D uses the same font
      // masking as the visible canvas (mock note: instance-level font, so only
      // the measureText path is observable in this harness).
      const oc4 = new winOC.OffscreenCanvas(300, 150);
      const octx4 = oc4.getContext('2d');
      octx4.font = '12px SimSun';
      const m = octx4.measureText('hello');
      assert.strictEqual(m.width, 50, 'offscreen measureText must use sanitized font metrics (no SimSun width bonus)');
      assert.strictEqual(octx4.font, '12px SimSun', 'measureText must restore the caller font');

      // A webgl-typed offscreen canvas takes the temp-canvas WebGL readback
      // path instead of the 2D export farble: the blob is farbled from a
      // throwaway 2D canvas while the webgl source canvas itself stays
      // untouched (no restore/race bookkeeping on the source).
      const oc5 = new winOC.OffscreenCanvas(300, 150);
      oc5.getContext('webgl');
      const b5 = await oc5.convertToBlob();
      assert.notStrictEqual(b5.r, 100, 'webgl-typed offscreen convertToBlob must export a farbled pixel (temp-canvas readback path)');
      assert.strictEqual(oc5._ctx._pixels[0], 100, 'the webgl-typed source canvas must stay untouched by the temp-canvas export');

      // 11.2 OffscreenCanvas on a normal site: farbled too (farbling is global,
      // gated only by the shield switch, not by isCYT).
      const winOCN = createMockWindow('normal-site.example', 'Linux x86_64');
      vm.runInContext(stealthCode, vm.createContext(winOCN));
      const ocN = new winOCN.OffscreenCanvas(300, 150);
      const octxN = ocN.getContext('2d');
      const blobN = await ocN.convertToBlob();
      assert.notStrictEqual(blobN.r, 100, 'convertToBlob on normal sites must be farbled (global farbling)');
      assert.strictEqual(octxN._pixels[0], 100, 'canvas must be restored to the true pixel after export');

      console.log('✓ OffscreenCanvas exports/measureText covered.');
    }

    // 11.3 Worker bootstrap WebGPU masking (functional): execute the generated
    // worker bootstrap in a fresh realm whose navigator.gpu exposes real-looking
    // adapter info, then read it back from the worker side. The bootstrap must
    // hand out the pooled persona (intel / interpolated architecture / empty
    // device+description) so a worker cannot contradict the main thread.
    {
      const realInfo = { vendor: 'nvidia', architecture: 'ampere', device: 'real-device', description: 'real-desc' };
      const workerSelf = {
        navigator: {
          gpu: {
            requestAdapter() {
              return Promise.resolve({
                info: Object.assign({}, realInfo),
                requestAdapterInfo() {
                  return Promise.resolve(Object.assign({}, realInfo));
                }
              });
            }
          }
        }
      };
      // The blob source is bootstrap + the page's own importScripts/import
      // line; run only the bootstrap (the import would need a worker network
      // stack that does not exist in a vm realm).
      const bootstrapOnly = workerBlob.content.replace(/\n(?:importScripts|import)\b[\s\S]*$/, '\n');
      assert(bootstrapOnly.includes('requestAdapter'), 'bootstrap-only source must still contain the WebGPU hook');
      vm.runInContext(bootstrapOnly, vm.createContext({ self: workerSelf }));
      const workerAdapter = await workerSelf.navigator.gpu.requestAdapter();
      assert(workerAdapter, 'worker mock adapter must resolve');
      assert.strictEqual(workerAdapter.info.vendor, 'intel', 'worker WebGPU info.vendor must be masked to intel');
      assert.strictEqual(workerAdapter.info.architecture, expectedGpuCYT.wgpuArch, 'worker WebGPU info.architecture must be the interpolated pooled architecture');
      assert.strictEqual(workerAdapter.info.architecture, workerArchMatch[1], 'functional worker architecture must match the bootstrap interpolation');
      assert.strictEqual(workerAdapter.info.device, '', 'worker WebGPU info.device must be emptied');
      assert.strictEqual(workerAdapter.info.description, '', 'worker WebGPU info.description must be emptied');
      const workerInfoDesc = Object.getOwnPropertyDescriptor(workerAdapter, 'info');
      assert(workerInfoDesc && typeof workerInfoDesc.get === 'function' && workerInfoDesc.enumerable === false,
        'worker WebGPU info must be a non-enumerable own getter (native accessor shape)');
      assert.strictEqual(workerAdapter.info, workerAdapter.info, 'worker WebGPU info must be a stable record');
      const workerInfo = await workerAdapter.requestAdapterInfo();
      assert.strictEqual(workerInfo.vendor, 'intel', 'worker requestAdapterInfo() must return the masked vendor');
      assert.strictEqual(workerInfo.architecture, expectedGpuCYT.wgpuArch, 'worker requestAdapterInfo() must return the masked architecture');
      assert.strictEqual(typeof workerSelf.navigator.gpu.requestAdapter, 'function', 'worker requestAdapter must stay callable');
      assert(/\[native code\]/.test(String(workerSelf.navigator.gpu.requestAdapter)), 'worker requestAdapter must keep a native-looking toString');
      console.log('✓ Worker-side navigator.gpu adapter info masked to the pooled persona.');
    }

    // 12. Regression: first-wave fix coverage (handshake ACK protocol,
    // offscreen WebGL exports, transfer restore cleanup, font cache
    // invalidation, inline font preservation, worker bootstrap Date, UTC tz).
    console.log('[Test 12] Validating first-wave fix regressions...');

    // 12.1 Handshake ACK protocol: a wrong-token '__bocchi_ack__' must NOT
    // disarm the replay window (only the token-matching ACK or the first
    // authenticated CE may). While armed, '__bocchi_req__' re-announces;
    // after the authenticated CE, it must stay silent (anti-fishing).
    {
      const winHS = createMockWindow('handshake-ack.example', 'Linux x86_64');
      vm.runInContext(stealthCode, vm.createContext(winHS));
      getEngineHandshake(winHS);
      const hsCount = () => winHS._dispatchedDocEvents.filter(e => e.type === '__bocchi_hs__').length;
      const hsBase = hsCount();
      dispatchUnauthenticated(winHS, '__bocchi_ack__', { t: 'ffffffffffffffffffffffffffffffff' });
      winHS.document.dispatchEvent({ type: '__bocchi_req__' });
      assert.strictEqual(hsCount(), hsBase + 1, 'a wrong-token __bocchi_ack__ must not disarm: __bocchi_req__ must still re-announce the handshake');
      driveConfig(winHS, { tz: 'Europe/Berlin' }); // authenticated CE completes the handshake flow
      winHS.document.dispatchEvent({ type: '__bocchi_req__' });
      assert.strictEqual(hsCount(), hsBase + 1, 'after the first authenticated CE, __bocchi_req__ must produce no new handshake (anti-fishing)');
      console.log('✓ ACK protocol: wrong-token ACK ignored, authenticated CE disarms replay.');
    }

    // 12.2 OffscreenCanvas webgl-type exports: getContext('webgl') marks the
    // canvas for the temp-canvas WebGL readback path — convertToBlob must
    // export perturbed pixels derived from the salted webgl seed, and the
    // source canvas must never be modified (no restore bookkeeping on it).
    // (Mock note: the mock models a webgl-typed offscreen canvas by tagging
    // _ctxType='webgl'; the engine's type map only needs a truthy context.)
    {
      const winOCW = createMockWindow('offscreen-webgl.example', 'Linux x86_64');
      vm.runInContext(stealthCode, vm.createContext(winOCW));
      const ocW = new winOCW.OffscreenCanvas(300, 150);
      assert(ocW.getContext('webgl'), 'mock offscreen webgl context must be created');
      const blobW = await ocW.convertToBlob();
      const ocwDelta = (djb2Hash('offscreen-webgl.example' + ':' + TEST_SESSION_SALT + ':webgl') % 12) * 2 + 1;
      assert.notStrictEqual(blobW.r, 100, 'offscreen webgl convertToBlob must export perturbed pixels (temp-canvas readback path)');
      assert.strictEqual(blobW.r, perturbPixelRef(100, ocwDelta), 'the perturbed pixel must match the djb2-derived webgl delta applied to the temp canvas pixel');
      assert.strictEqual(blobW.a, 255, 'offscreen webgl blob alpha must stay opaque');
      assert.strictEqual(ocW._ctx._pixels[0], 100, 'the webgl-typed source canvas must not be modified by the temp-canvas export');
      console.log('✓ OffscreenCanvas webgl-type convertToBlob farbles via the temp-canvas readback.');
    }

    // 12.3 transferToImageBitmap must drop the pending export-restore record:
    // a convertToBlob still in flight when the transfer blanks the canvas
    // must NOT write its remembered true pixel back afterwards.
    {
      const winTR = createMockWindow('transfer-restore.example', 'Linux x86_64');
      vm.runInContext(stealthCode, vm.createContext(winTR));
      const ocT = new winTR.OffscreenCanvas(300, 150);
      const octxT = ocT.getContext('2d');
      const pendingBlob = ocT.convertToBlob(); // async export pending: true pixel is remembered
      const bmT = ocT.transferToImageBitmap(); // transfer blanks the canvas + must drop the record
      assert.notStrictEqual(bmT.r, 100, 'transferToImageBitmap must carry a farbled pixel');
      await pendingBlob;
      assert.strictEqual(octxT._pixels[0], 0, 'the still-pending convertToBlob restore must not repaint the blank canvas (record dropped by the transfer)');
      console.log('✓ transferToImageBitmap clears pending restore records (no stale repaint).');
    }

    // 12.4 needsFontMasking cache invalidation: a verdict computed under one
    // protection/config state must never be served after the state changes.
    // (a) the module toggle gates the whole masking path; (b) a whitelisted
    // SimSun verdict (false, cached while active) must be recomputed when the
    // allowedFonts list is replaced (identity-based cache signature).
    {
      const winFM = createMockWindow('font-cache.example', 'Linux x86_64');
      vm.runInContext(stealthCode, vm.createContext(winFM));
      driveConfig(winFM, { cfg: { fontProtection: false } });
      const fmEl = new winFM.HTMLElement();
      fmEl.style.fontFamily = '"SimSun", monospace';
      assert.strictEqual(fmEl.offsetWidth, 220, 'With fontProtection=false, the SimSun probe must read the native 220 width');
      driveConfig(winFM, { cfg: { fontProtection: true } });
      assert.strictEqual(fmEl.offsetWidth, 150, 'After re-enabling fontProtection, the SAME element must mask again (150)');
      driveConfig(winFM, { fonts: { allowedFonts: ['SimSun'], customFonts: [], blockBuiltin: true } });
      const fmEl2 = new winFM.HTMLElement();
      fmEl2.style.fontFamily = '"SimSun", monospace';
      assert.strictEqual(fmEl2.offsetWidth, 220, 'A whitelisted SimSun must read natively (false verdict enters the cache)');
      driveConfig(winFM, { fonts: { allowedFonts: [], customFonts: [], blockBuiltin: true } });
      assert.strictEqual(fmEl2.offsetWidth, 150, 'After the whitelist is dropped, the SAME element must mask again (stale false verdict must not be served)');
      console.log('✓ needsFontMasking verdicts are invalidated by protection/config changes.');
    }

    // 12.5 withMaskedElementFont must preserve BOTH inline declarations: an
    // element carrying an untouched fontFamily plus a masked CJK font
    // shorthand must come back byte-identical on both properties.
    {
      const winFIB = createMockWindow('font-inline.example', 'Linux x86_64');
      vm.runInContext(stealthCode, vm.createContext(winFIB));
      const fibEl = new winFIB.HTMLElement();
      fibEl.style.fontFamily = 'Arial';
      fibEl.style.font = '12px "SimSun", serif';
      fibEl.getBoundingClientRect();
      assert.strictEqual(fibEl.style.fontFamily, 'Arial', 'the untouched inline fontFamily must survive a masked measurement exactly');
      assert.strictEqual(fibEl.style.font, '12px "SimSun", serif', 'the masked inline font shorthand must be restored byte-identically');
      // Control: a CJK font shorthand alone (empty fontFamily) must actually
      // drive the masking swap — otherwise the restore checks above are vacuous.
      const fibEl2 = new winFIB.HTMLElement();
      fibEl2.style.font = '12px "SimSun", serif';
      assert.strictEqual(fibEl2.getBoundingClientRect().width, 100, 'a CJK font shorthand alone must trigger metric masking (100, not the SimSun 180)');
      assert.strictEqual(fibEl2.style.font, '12px "SimSun", serif', 'the font shorthand must be restored after getBoundingClientRect');
      assert.strictEqual(fibEl2.style.fontFamily, '', 'the empty inline fontFamily must stay untouched');
      console.log('✓ Inline fontFamily and font shorthand both survive masked measurements.');
    }

    // 12.6 Worker bootstrap Date consistency: the bootstrap baked into the
    // blob must carry the page's synced timezone and convert worker-side
    // Date reads/writes (getHours/setHours) in that zone. Executed
    // functionally in a worker-shaped realm (engine NOT loaded there, so the
    // only Date/Intl hooks present are the bootstrap's own).
    // (Harness limitation: the mock's isolated Intl ctor returns host-proto
    // instances on function-call construction, so the bootstrap's
    // Intl.DateTimeFormat.resolvedOptions hook is not reachable here — real
    // worker realms patch their own realm prototype. The Date hooks — the
    // point of this check — are fully exercisable.)
    {
      const winWB = createMockWindow('worker-date.example', 'Linux x86_64');
      vm.runInContext(stealthCode, vm.createContext(winWB));
      driveConfig(winWB, { tz: 'America/New_York' });
      const wbWorker = new winWB.Worker('date-worker.js');
      const wbBlob = winWB.URL._created.get(wbWorker.scriptURL);
      assert(wbBlob, 'Worker must be blob-wrapped for the bootstrap Date check');
      assert(wbBlob.content.includes('"America/New_York"'), 'the worker bootstrap must bake the synced timezone into its source');
      const wbBootstrap = wbBlob.content.replace(/\n(?:importScripts|import)\b[\s\S]*$/, '\n');
      const wbShell = createMockWindow('worker-date-shell.example'); // engine NOT loaded
      const wbSelf = {
        Date: wbShell.Date,
        Intl: wbShell.Intl,
        navigator: {
          gpu: {
            requestAdapter() {
              const realInfo = { vendor: 'nvidia', architecture: 'ampere', device: 'real-device', description: 'real-desc' };
              return Promise.resolve({
                info: Object.assign({}, realInfo),
                requestAdapterInfo() { return Promise.resolve(Object.assign({}, realInfo)); }
              });
            }
          }
        }
      };
      vm.runInContext(wbBootstrap, vm.createContext({ self: wbSelf }));
      const wbDate = new wbSelf.Date('2026-09-29T12:00:00Z');
      assert.strictEqual(wbDate.getHours(), 8, 'worker Date getHours must render NY EDT (8) for 12:00Z');
      wbDate.setHours(15);
      assert.strictEqual(wbDate.getHours(), 15, 'worker setHours(15) must land on hour 15 in the target zone');
      assert.strictEqual(wbDate.getTime(), Date.UTC(2026, 8, 29, 19, 0, 0), 'worker setHours must map 15:00 NY (EDT) back to the 19:00Z epoch');
      assert(wbDate.toString().includes('GMT-0400'), 'worker Date.toString must carry the NY EDT offset');
      console.log('✓ Worker bootstrap converts Date reads/writes in the synced timezone.');
    }

    // 12.7 updateActiveTimezone must accept 'UTC' (a legal IANA id without a
    // '/' segment — the slash-only guard must not reject it).
    {
      const winUTCTz = createMockWindow('utc-target.example', 'Linux x86_64');
      vm.runInContext(stealthCode, vm.createContext(winUTCTz));
      driveConfig(winUTCTz, { tz: 'UTC' });
      assert.strictEqual(new winUTCTz.Intl.DateTimeFormat().resolvedOptions().timeZone, 'UTC', "driveConfig tz:'UTC' must be accepted and reported back");
      const utcDate = new winUTCTz.Date('2026-09-29T12:00:00Z');
      assert.strictEqual(utcDate.getTimezoneOffset(), 0, 'A UTC target must report a zero offset');
      assert.strictEqual(utcDate.getHours(), utcDate.getUTCHours(), 'Local hours must equal UTC hours under a UTC target');
      console.log('✓ updateActiveTimezone accepts the UTC zone id.');
    }

    console.log('✓ First-wave fix regressions fully passed.\n');

    console.log('=== ALL TESTS PASSED SUCCESSFULLY! ===');
  });
});
