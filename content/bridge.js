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
    'canvasStrength', 'audioStrength', 'hardwareStrength', 'webrtcDevices', 'webrtcLocalIp'
  ];

  const SHIELD_KEYS = [
    'globalShieldEnabled', 'siteBypassList',
    'canvasProtection', 'webrtcProtection', 'audioProtection',
    'timezoneProtection', 'hardwareProtection', 'fontProtection',
    'canvasStrength', 'audioStrength', 'hardwareStrength', 'webrtcDevices', 'webrtcLocalIp',
    'blockOtherScripts', 'blockSymbols'
  ];

  function normalizeDomain(d) {
    if (!d || typeof d !== 'string') return '';
    return d.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^\*\.?/, '').replace(/^\.+/, '').split('/')[0].split(':')[0];
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
      blockBuiltin: res && typeof res.blockBuiltinChineseFonts === 'boolean' ? res.blockBuiltinChineseFonts : true,
      fontMode: res && typeof res.fontMode === 'string' ? res.fontMode : 'blacklist',
      blockOtherScripts: res && typeof res.blockOtherScripts === 'boolean' ? res.blockOtherScripts : false,
      blockSymbols: res && typeof res.blockSymbols === 'boolean' ? res.blockSymbols : false,
      fontProtection: res && typeof res.fontProtection === 'boolean' ? res.fontProtection : true
    };
  }

  function buildGeoDetail(res) {
    return {
      enabled: res ? res.geolocationProtection === true : false,
      latitude: res && typeof res.geolocationLatitude === 'number' ? res.geolocationLatitude : undefined,
      longitude: res && typeof res.geolocationLongitude === 'number' ? res.geolocationLongitude : undefined
    };
  }

  function buildCfgDetail(res) {
    const bypassList = Array.isArray(res && res.siteBypassList) ? res.siteBypassList : [];
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
      canvasStrength: ['light', 'standard', 'strong'].includes(res && res.canvasStrength) ? res.canvasStrength : 'standard',
      audioStrength: ['light', 'standard', 'strong'].includes(res && res.audioStrength) ? res.audioStrength : 'standard',
      hardwareStrength: ['light', 'standard', 'strong'].includes(res && res.hardwareStrength) ? res.hardwareStrength : 'standard',
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
    if (mode === 'manual') return manual;
    if (mode === 'geo') {
      // 位置模块关闭时与面板一致:回退出口 IP,不跟随一个并未生效的位置
      const geoOn = res && res.geolocationProtection === true;
      return (geoOn && typeof res.geoTimezone === 'string' && res.geoTimezone) || ipTz;
    }
    return ipTz;
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
              if (response && response.timezone) {
                sendPayload({ tz: response.timezone });
              }
            });
          } catch (_) {}
        }

        const payload = {
          tz: tz || undefined,
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

      if (changes.timezone || changes.targetTimezone || changes.timezoneMode || changes.manualTimezone || changes.geoTimezone || changes.geolocationProtection) {
        chrome.storage.local.get(['timezone', 'targetTimezone', 'timezoneMode', 'manualTimezone', 'geoTimezone', 'geolocationProtection'], (res) => {
          const newTz = resolveTimezone(res);
          if (newTz) {
            sendPayload({ tz: newTz });
          }
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
        chrome.storage.local.get(ALL_KEYS, (res) => {
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
