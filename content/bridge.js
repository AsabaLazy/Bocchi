'use strict';

/**
 * Bocchi Privacy Shield - Isolated World Bridge
 *
 * Runs in ISOLATED world at document_start.
 * Reads egress IP timezone and privacy shield configuration cached in chrome.storage.local
 * and synchronizes it to the MAIN world stealth engine over a handshake-secured
 * channel (protocol v2.1):
 *
 *  1. The MAIN world engine generates a random token T and a random config event
 *     name CE, dispatches '__bocchi_hs__' with detail { t: T, e: CE }, and keeps
 *     its handshake replay channel armed until it receives the matching ACK.
 *  2. Because the engine runs before this script, we missed the initial broadcast;
 *     we dispatch '__bocchi_req__' at once so the engine re-sends the handshake.
 *     This exchange happens in the document_start window, before any page script
 *     can observe it.
 *  3. On the first valid handshake we synchronously dispatch '__bocchi_ack__'
 *     with detail { t: T } before any async work (storage reads, config pushes).
 *     The ACK closes the loop while still inside the document_start window: the
 *     engine disarms its replay channel, so page scripts that later dispatch
 *     '__bocchi_req__' get no '__bocchi_hs__' response and cannot fish for the
 *     token, and a forged ACK carrying the wrong token is ignored engine-side.
 *     Page scripts can thus neither observe nor forge the handshake exchange.
 *  4. All config syncs afterwards go to CE with detail { t: T, tz?, fonts?, cfg? }.
 *     The engine validates detail.t === T and ignores anything else, so page
 *     scripts can neither spoof config events nor learn the channel name.
 *  5. No fallback: if no handshake ever arrives (engine missing), payloads are
 *     simply dropped — the engine no longer listens on any fixed event name,
 *     so dispatching there would only broadcast into the void, and without an
 *     engine there is no protection left to configure anyway.
 */

(() => {
  // Handshake state. The token/channel are only ever set from the first valid
  // '__bocchi_hs__' handshake, which is exchanged in the document_start
  // window before any page script can run or observe it.
  let handshakeToken = null;   // T: 16-byte hex string from the engine
  let configEventName = null;  // CE: random config event name from the engine

  const ALL_KEYS = [
    'timezone', 'targetTimezone', 'timezoneMode', 'manualTimezone', 'geoTimezone',
    'geolocationProtection', 'geolocationLatitude', 'geolocationLongitude',
    'customHiddenFonts', 'customAllowedFonts', 'blockBuiltinChineseFonts', 'fontMode', 'blockOtherScripts', 'blockSymbols',
    'globalShieldEnabled', 'siteBypassList',
    'canvasProtection', 'webrtcProtection', 'audioProtection', 'timezoneProtection', 'hardwareProtection', 'fontProtection',
    'languageProtection', 'languageTarget', 'languageNavigator', 'languageIntl',
    'canvas2dExport', 'canvas2dPixels', 'canvasWebglExport',
    'audioGetChannelData', 'audioCopyFromChannel',
    'hardwareGpu', 'hardwareScreen', 'hardwareTimer', 'hardwareGamepad',
    'webrtcBlockSupport', 'webrtcBlockDevices', 'webrtcBlockObjects',
    'webrtcDevices', 'webrtcLocalIp'
  ];

  const SHIELD_KEYS = [
    'globalShieldEnabled', 'siteBypassList',
    'canvasProtection', 'webrtcProtection', 'audioProtection',
    'timezoneProtection', 'hardwareProtection', 'fontProtection',
    'languageProtection', 'languageTarget', 'languageNavigator', 'languageIntl',
    'canvas2dExport', 'canvas2dPixels', 'canvasWebglExport',
    'audioGetChannelData', 'audioCopyFromChannel',
    'hardwareGpu', 'hardwareScreen', 'hardwareTimer', 'hardwareGamepad',
    'webrtcBlockSupport', 'webrtcBlockDevices', 'webrtcBlockObjects',
    'webrtcDevices', 'webrtcLocalIp',
    'blockOtherScripts', 'blockSymbols'
  ];

  const LANGUAGE_DEFAULT = 'en-US';

  // Keep in sync with background/service_worker.js: a public suffix is not a
  // bypassable site. Forwarding `com`/`co.uk` would make the engine treat
  // every site under that suffix as bypassed.
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
    // Keep ordinary single-label intranet hosts; only bare TLDs are rejected.
    if (!host.includes('.')) {
      return /^[a-z]{2}$/.test(host) || PUBLIC_SUFFIX_SINGLE.has(host);
    }
    return PUBLIC_SUFFIX_ONLY_HOSTS.has(host);
  }

  function normalizeDomain(d) {
    if (!d || typeof d !== 'string') return '';
    let s = d.trim().toLowerCase();
    if (!s) return '';
    // Strip scheme/credentials/path without relying on URL.hostname (also
    // keeps bracket IPv6 literals intact for exclusion matching).
    if (/^[a-z][a-z0-9+.-]*:\/\//.test(s)) {
      s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//, '').split(/[/?#]/)[0];
      const at = s.lastIndexOf('@');
      if (at >= 0) s = s.slice(at + 1);
    }
    s = s.replace(/^\*\.?/, '').replace(/^\.+/, '');
    if (s.startsWith('[')) {
      const end = s.indexOf(']');
      if (end < 0) return '';
      const host = s.slice(0, end + 1);
      return /^\[[0-9a-f:.]+\]$/.test(host) && host.includes(':') ? host : '';
    }
    s = s.split('/')[0].split(':')[0].replace(/\.+$/, '');
    if (!s) return '';
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(s)) {
      return s.split('.').every(part => Number(part) <= 255) ? s : '';
    }
    if (!/^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(s)) return '';
    return isBarePublicSuffix(s) ? '' : s;
  }

  // Strict validators for values that cross into the MAIN world. The engine
  // trusts authenticated payloads, so a malformed storage value must be
  // normalized here rather than forwarded as-is.
  function normalizeLanguageTarget(value) {
    if (typeof value !== 'string') return LANGUAGE_DEFAULT;
    const v = value.trim();
    return /^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/.test(v) ? v : LANGUAGE_DEFAULT;
  }

  function normalizeTimezone(value) {
    if (typeof value !== 'string') return '';
    const tz = value.trim();
    if (!tz || tz.length > 64) return '';
    if (!/^[A-Za-z][A-Za-z0-9_+\-]*(?:\/[A-Za-z0-9_+\-]+)*$/.test(tz)) return '';
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: tz });
      return tz;
    } catch (_) {
      return '';
    }
  }

  function normalizeCoordinate(value, min, max) {
    return (typeof value === 'number' && isFinite(value) && value >= min && value <= max)
      ? value
      : undefined;
  }

  function calculateIsBypassed(siteBypassList) {
    if (!Array.isArray(siteBypassList) || siteBypassList.length === 0) return false;
    let host = '';
    try {
      if (typeof location !== 'undefined' && location.hostname) {
        host = location.hostname.toLowerCase();
      }
    } catch (_) {}
    if (!host) return false;
    return siteBypassList.some(site => {
      const s = normalizeDomain(site);
      return s && (host === s || host.endsWith('.' + s));
    });
  }

  function safeDispatch(name, detail) {
    try {
      document.dispatchEvent(new CustomEvent(name, { detail: detail }));
    } catch (_) {}
  }

  // ------------------------------------------------------------------
  // Handshake handling (protocol v2.1)
  // ------------------------------------------------------------------

  function onHandshake(evt) {
    try {
      // First valid handshake wins. Later '__bocchi_hs__' events could be
      // forged by page scripts (the handshake event name is public); the
      // engine never legitimately changes {T, CE} mid-session, so ignoring
      // anything after the first handshake prevents channel hijacking.
      if (handshakeToken !== null) {
        return;
      }
      const d = evt && evt.detail;
      if (!d || typeof d.t !== 'string' || !d.t || typeof d.e !== 'string' || !d.e) {
        return;
      }
      handshakeToken = d.t;
      configEventName = d.e;
      // ACK the handshake synchronously, before any async work (storage reads,
      // config pushes): the engine disarms its replay channel on this
      // token-matching ACK, so the loop closes entirely inside the
      // document_start window and page scripts can neither observe nor forge
      // it afterwards.
      safeDispatch('__bocchi_ack__', { t: handshakeToken });
      // Push a full config payload over the secured channel.
      sendInitialConfig();
    } catch (_) {}
  }

  // ------------------------------------------------------------------
  // Payload builders. Field names/defaults mirror the engine-side handler
  // of the secured config event (d.tz / d.fonts / d.cfg in section 9), so
  // every payload parses directly into the engine registries.
  // ------------------------------------------------------------------

  function buildFontsDetail(res) {
    return {
      customFonts: Array.isArray(res && res.customHiddenFonts) ? res.customHiddenFonts : [],
      allowedFonts: Array.isArray(res && res.customAllowedFonts) ? res.customAllowedFonts : [],
      blockBuiltin: res && typeof res.blockBuiltinChineseFonts === 'boolean' ? res.blockBuiltinChineseFonts : false,
      fontMode: res && typeof res.fontMode === 'string' ? res.fontMode : 'blacklist',
      blockOtherScripts: res && typeof res.blockOtherScripts === 'boolean' ? res.blockOtherScripts : false,
      blockSymbols: res && typeof res.blockSymbols === 'boolean' ? res.blockSymbols : false,
      fontProtection: res && typeof res.fontProtection === 'boolean' ? res.fontProtection : true
    };
  }

  function buildGeoDetail(res) {
    return {
      enabled: res ? res.geolocationProtection === true : false,
      latitude: normalizeCoordinate(res && res.geolocationLatitude, -90, 90),
      longitude: normalizeCoordinate(res && res.geolocationLongitude, -180, 180)
    };
  }

  function buildCfgDetail(res) {
    // Drop invalid and public-suffix entries before they reach the engine:
    // the engine's own matcher only checks host suffix semantics, so a
    // stored `com` would bypass every .com site if forwarded.
    const bypassList = Array.isArray(res && res.siteBypassList)
      ? res.siteBypassList.filter(site => !!normalizeDomain(site))
      : [];
    return {
      globalShieldEnabled: res ? res.globalShieldEnabled !== false : true,
      isBypassed: calculateIsBypassed(bypassList),
      siteBypassList: bypassList,
      canvasProtection: res ? res.canvasProtection !== false : true,
      webrtcProtection: res ? res.webrtcProtection !== false : true,
      audioProtection: res ? res.audioProtection !== false : true,
      timezoneProtection: res ? res.timezoneProtection !== false : true,
      hardwareProtection: res ? res.hardwareProtection !== false : true,
      fontProtection: res ? res.fontProtection !== false : true,
      languageProtection: res ? res.languageProtection === true : false,
      languageTarget: normalizeLanguageTarget(res && res.languageTarget),
      languageNavigator: res ? res.languageNavigator !== false : true,
      languageIntl: res ? res.languageIntl !== false : true,
      canvas2dExport: res ? res.canvas2dExport !== false : true,
      canvas2dPixels: res ? res.canvas2dPixels !== false : true,
      canvasWebglExport: res ? res.canvasWebglExport !== false : true,
      audioGetChannelData: res ? res.audioGetChannelData !== false : true,
      audioCopyFromChannel: res ? res.audioCopyFromChannel !== false : true,
      hardwareGpu: res ? res.hardwareGpu !== false : true,
      hardwareScreen: res ? res.hardwareScreen !== false : true,
      hardwareTimer: res ? res.hardwareTimer !== false : true,
      hardwareGamepad: res ? res.hardwareGamepad === true : false,
      webrtcBlockSupport: res ? res.webrtcBlockSupport === true : false,
      webrtcBlockDevices: res ? res.webrtcBlockDevices === true : false,
      webrtcBlockObjects: res ? res.webrtcBlockObjects === true : false,
      webrtcDevices: res ? res.webrtcDevices !== false : true,
      webrtcLocalIp: res ? res.webrtcLocalIp !== false : true,
      blockOtherScripts: res ? !!res.blockOtherScripts : false,
      blockSymbols: res ? !!res.blockSymbols : false
    };
  }

  // Send a config payload. `payload` may contain any subset of
  // { tz, fonts, cfg }.
  // Route: CE (with token) after handshake; dropped otherwise.
  function sendPayload(payload) {
    if (typeof payload !== 'object' || !payload) return;

    if (handshakeToken !== null && configEventName !== null) {
      try {
        payload.t = handshakeToken;
      } catch (_) {}
      safeDispatch(configEventName, payload);
      return;
    }

    // No handshake yet: drop the payload. The engine is the only possible
    // listener, it has not announced a channel, and if it never loads there
    // is no protection to configure. A later handshake triggers a full
    // config push from the handshake handler, so nothing is lost.
  }

  // Resolve the effective zone for the three modes. 'geo' uses the zone the
  // panel derived from the spoofed coordinates (geoTimezone), falling back to
  // the egress-IP cache until the panel has derived one.
  function resolveTimezone(res) {
    const mode = res && res.timezoneMode === 'manual' ? 'manual' : (res && res.timezoneMode === 'geo' ? 'geo' : 'auto');
    const manual = res && typeof res.manualTimezone === 'string' ? res.manualTimezone : '';
    const ipTz = (res && (res.timezone || res.targetTimezone)) || '';
    if (mode === 'manual') return normalizeTimezone(manual);
    if (mode === 'geo') {
      // 位置模块关闭时与面板一致:回退出口 IP,不跟随一个并未生效的位置
      const geoOn = res && res.geolocationProtection === true;
      return (geoOn && typeof res.geoTimezone === 'string' && res.geoTimezone)
        ? normalizeTimezone(res.geoTimezone)
        : normalizeTimezone(ipTz);
    }
    return normalizeTimezone(ipTz);
  }

  // ------------------------------------------------------------------
  // Initial sync: read all keys, fetch timezone via runtime message as a
  // fallback, then send one full tz+fonts+cfg payload.
  // ------------------------------------------------------------------

  function sendInitialConfig() {
    try {
      if (typeof chrome === 'undefined' || !chrome.storage || !chrome.storage.local || !chrome.storage.local.get) {
        return;
      }
      chrome.storage.local.get(ALL_KEYS, (res) => {
        const tz = resolveTimezone(res);
        if (!tz && typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.sendMessage) {
          try {
            chrome.runtime.sendMessage({ type: 'GET_TIMEZONE' }, (response) => {
              const responseTz = response && normalizeTimezone(response.timezone);
              if (responseTz) {
                sendPayload({ tz: responseTz });
              }
            });
          } catch (_) {}
        }

        const payload = {
          // Explicit null means "no target": the engine must clear any
          // previously applied zone and stay native (e.g. after switching
          // from manual back to auto with no GeoIP cache yet).
          tz: tz || null,
          fonts: buildFontsDetail(res),
          cfg: buildCfgDetail(res),
          geo: buildGeoDetail(res)
        };
        sendPayload(payload);
      });
    } catch (_) {}
  }

  // ------------------------------------------------------------------
  // Real-time sync: incremental payloads on storage changes.
  // ------------------------------------------------------------------

  function onStorageChanged(changes, area) {
    try {
      if (area !== 'local' || !changes) {
        return;
      }
      // No handshake yet means there is no authenticated channel: return
      // before doing any storage reads whose results would only be dropped.
      if (handshakeToken === null || configEventName === null) {
        return;
      }
      if (typeof chrome === 'undefined' || !chrome.storage || !chrome.storage.local || !chrome.storage.local.get) {
        return;
      }

      if (changes.timezone || changes.targetTimezone || changes.timezoneMode || changes.manualTimezone || changes.geoTimezone || changes.geolocationProtection) {
        chrome.storage.local.get(['timezone', 'targetTimezone', 'timezoneMode', 'manualTimezone', 'geoTimezone', 'geolocationProtection'], (res) => {
          // Always send: an empty resolution is an explicit null reset, not
          // "leave the previous manual zone in place".
          sendPayload({ tz: resolveTimezone(res) || null });
        });
      }
      if (changes.geolocationProtection || changes.geolocationLatitude || changes.geolocationLongitude) {
        chrome.storage.local.get(['geolocationProtection', 'geolocationLatitude', 'geolocationLongitude'], (res) => {
          sendPayload({ geo: buildGeoDetail(res) });
        });
      }
      if (changes.customHiddenFonts || changes.customAllowedFonts || changes.blockBuiltinChineseFonts || changes.fontMode || changes.blockOtherScripts || changes.blockSymbols || changes.fontProtection) {
        chrome.storage.local.get(['customHiddenFonts', 'customAllowedFonts', 'blockBuiltinChineseFonts', 'fontMode', 'blockOtherScripts', 'blockSymbols', 'fontProtection'], (res) => {
          sendPayload({ fonts: buildFontsDetail(res) });
        });
      }
      if (SHIELD_KEYS.some(k => k in changes)) {
        chrome.storage.local.get(SHIELD_KEYS, (res) => {
          sendPayload({ cfg: buildCfgDetail(res) });
        });
      }
    } catch (_) {}
  }

  // ------------------------------------------------------------------
  // Bootstrap
  // ------------------------------------------------------------------

  try {
    if (typeof document !== 'undefined' && document.addEventListener) {
      // a. Register the handshake listener immediately.
      document.addEventListener('__bocchi_hs__', onHandshake, true);

      // b. Ask the engine to re-send the handshake we missed at document_start.
      //    The engine answers synchronously, so onHandshake above already ACKs
      //    the handshake and pushes the full config over the secured channel.
      //    If the engine is missing, no handshake ever arrives and every
      //    payload is dropped (there is no protection to configure); no retry
      //    or legacy fallback is needed.
      safeDispatch('__bocchi_req__', null);
    }
  } catch (_) {}

  try {
    if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.onChanged && chrome.storage.onChanged.addListener) {
      chrome.storage.onChanged.addListener(onStorageChanged);
    }
  } catch (_) {}
})();
