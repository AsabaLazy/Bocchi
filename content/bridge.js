'use strict';

/**
 * Bocchi Privacy Shield - Isolated World Bridge
 *
 * Runs in ISOLATED world at document_start.
 * Reads egress IP timezone and privacy shield configuration cached in chrome.storage.local
 * and synchronously synchronizes it to the MAIN world stealth engine via custom events.
 */
(() => {
  if (typeof chrome === 'undefined' || !chrome.storage || !chrome.storage.local) {
    return;
  }

  const ALL_KEYS = [
    'timezone', 'targetTimezone',
    'customHiddenFonts', 'customAllowedFonts', 'blockBuiltinChineseFonts', 'fontMode', 'blockOtherScripts',
    'globalShieldEnabled', 'siteBypassList',
    'canvasProtection', 'webrtcProtection', 'audioProtection', 'timezoneProtection', 'hardwareProtection', 'fontProtection'
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

  function dispatchTimezone(tz) {
    if (!tz || typeof tz !== 'string') return;
    try {
      const event = new CustomEvent('__bocchi_tz_sync__', {
        detail: { timezone: tz }
      });
      document.dispatchEvent(event);
    } catch (_) {}
  }

  function dispatchFontConfig(customFonts, allowedFonts, blockBuiltin, fontMode, blockOther, fontProt) {
    try {
      const event = new CustomEvent('__bocchi_fonts_sync__', {
        detail: {
          customFonts: Array.isArray(customFonts) ? customFonts : [],
          allowedFonts: Array.isArray(allowedFonts) ? allowedFonts : [],
          blockBuiltin: typeof blockBuiltin === 'boolean' ? blockBuiltin : true,
          fontMode: typeof fontMode === 'string' ? fontMode : 'blacklist',
          blockOtherScripts: typeof blockOther === 'boolean' ? blockOther : false,
          fontProtection: typeof fontProt === 'boolean' ? fontProt : true
        }
      });
      document.dispatchEvent(event);
    } catch (_) {}
  }

  function dispatchShieldConfig(res) {
    try {
      const bypassList = Array.isArray(res && res.siteBypassList) ? res.siteBypassList : [];
      const isBypassed = calculateIsBypassed(bypassList);

      const event = new CustomEvent('__bocchi_config_sync__', {
        detail: {
          globalShieldEnabled: res ? res.globalShieldEnabled !== false : true,
          isBypassed: isBypassed,
          siteBypassList: bypassList,
          canvasProtection: res ? res.canvasProtection !== false : true,
          webrtcProtection: res ? res.webrtcProtection !== false : true,
          audioProtection: res ? res.audioProtection !== false : true,
          timezoneProtection: res ? res.timezoneProtection !== false : true,
          hardwareProtection: res ? res.hardwareProtection !== false : true,
          fontProtection: res ? res.fontProtection !== false : true,
          blockOtherScripts: res ? !!res.blockOtherScripts : false
        }
      });
      document.dispatchEvent(event);
    } catch (_) {}
  }

  // Initial read from chrome.storage.local
  chrome.storage.local.get(ALL_KEYS, (res) => {
    const tz = (res && (res.timezone || res.targetTimezone));
    if (tz) {
      dispatchTimezone(tz);
    } else if (chrome.runtime && chrome.runtime.sendMessage) {
      try {
        chrome.runtime.sendMessage({ type: 'GET_TIMEZONE' }, (response) => {
          if (response && response.timezone) {
            dispatchTimezone(response.timezone);
          }
        });
      } catch (_) {}
    }

    dispatchFontConfig(
      res && res.customHiddenFonts,
      res && res.customAllowedFonts,
      res && res.blockBuiltinChineseFonts,
      res && res.fontMode,
      res && res.blockOtherScripts,
      res && res.fontProtection
    );

    dispatchShieldConfig(res || {});
  });

  // Listen for real-time changes
  if (chrome.storage.onChanged) {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'local') {
        if (changes.timezone || changes.targetTimezone) {
          const newTz = (changes.timezone && changes.timezone.newValue) ||
                        (changes.targetTimezone && changes.targetTimezone.newValue);
          if (newTz) {
            dispatchTimezone(newTz);
          }
        }
        if (changes.customHiddenFonts || changes.customAllowedFonts || changes.blockBuiltinChineseFonts || changes.fontMode || changes.blockOtherScripts || changes.fontProtection) {
          chrome.storage.local.get(['customHiddenFonts', 'customAllowedFonts', 'blockBuiltinChineseFonts', 'fontMode', 'blockOtherScripts', 'fontProtection'], (res) => {
            dispatchFontConfig(
              res && res.customHiddenFonts,
              res && res.customAllowedFonts,
              res && res.blockBuiltinChineseFonts,
              res && res.fontMode,
              res && res.blockOtherScripts,
              res && res.fontProtection
            );
          });
        }
        const SHIELD_KEYS = ['globalShieldEnabled', 'siteBypassList', 'canvasProtection', 'webrtcProtection', 'audioProtection', 'timezoneProtection', 'hardwareProtection', 'fontProtection', 'blockOtherScripts'];
        if (SHIELD_KEYS.some(k => k in changes)) {
          chrome.storage.local.get(ALL_KEYS, (res) => {
            dispatchShieldConfig(res || {});
          });
        }
      }
    });
  }
})();
