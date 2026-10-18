/**
 * Bocchi Privacy Shield - Stealth Engine
 *
 * Runs in MAIN world (run_at: document_start).
 * Provides deterministic, multi-realm evasion against advanced browser fingerprinting
 * and tracking diagnostics (BrowserLeaks, EFF Cover Your Tracks).
 */
(() => {
  'use strict';

  // Realm-local registries (closure-scoped). Previously these were shared across
  // realms via Symbol.for keys on window.top; page scripts could look up those
  // well-known symbols and tamper with nativeMap / shieldConfig directly.
  const nativeMap = new WeakMap();
  const protectedWindows = new WeakSet();
  const canvasContextTypeMap = new WeakMap();
  const audioFarbledMap = new WeakMap();
  // Per-window memo of the per-page-load farbling salt (see applyStealth).
  const windowSaltMap = new WeakMap();

  // Global timezone state (defaulting to America/Los_Angeles, dynamically synced)
  let activeTimezone = 'America/Los_Angeles';

  // Privacy Shield configuration registry (Master switch, per-site bypass, 5 core modules, font switch)
  const shieldConfig = {};
  if (typeof shieldConfig.globalShieldEnabled !== 'boolean') shieldConfig.globalShieldEnabled = true;
  if (typeof shieldConfig.isBypassed !== 'boolean') shieldConfig.isBypassed = false;
  if (typeof shieldConfig.canvasProtection !== 'boolean') shieldConfig.canvasProtection = true;
  if (typeof shieldConfig.webrtcProtection !== 'boolean') shieldConfig.webrtcProtection = true;
  if (typeof shieldConfig.audioProtection !== 'boolean') shieldConfig.audioProtection = true;
  if (typeof shieldConfig.timezoneProtection !== 'boolean') shieldConfig.timezoneProtection = true;
  if (typeof shieldConfig.hardwareProtection !== 'boolean') shieldConfig.hardwareProtection = true;
  if (typeof shieldConfig.fontProtection !== 'boolean') shieldConfig.fontProtection = true;
  if (!Array.isArray(shieldConfig.siteBypassList)) shieldConfig.siteBypassList = [];

  // Font privacy configuration registry (supports built-in CJK regex and user-custom font rules)
  const fontConfig = {};
  if (!Array.isArray(fontConfig.customHiddenFonts)) fontConfig.customHiddenFonts = [];
  if (!Array.isArray(fontConfig.customAllowedFonts)) fontConfig.customAllowedFonts = [];
  if (typeof fontConfig.blockBuiltinChineseFonts !== 'boolean') fontConfig.blockBuiltinChineseFonts = true;
  if (typeof fontConfig.blockOtherScripts !== 'boolean') fontConfig.blockOtherScripts = false;
  if (typeof fontConfig.fontMode !== 'string') fontConfig.fontMode = 'blacklist';

  /**
   * Resolve hostname for target realm with iframe fallback.
   */
  function resolveHostName(win) {
    let host = '';
    try {
      if (win && win.location && win.location.hostname) {
        host = win.location.hostname;
      }
    } catch (_) {}
    if (!host) {
      try {
        if (win && win.top && win.top.location && win.top.location.hostname) {
          host = win.top.location.hostname;
        }
      } catch (_) {}
    }
    if (!host) {
      try {
        if (win && win.document && win.document.referrer) {
          host = new URL(win.document.referrer).hostname;
        }
      } catch (_) {}
    }
    return host || 'localhost';
  }

  function normalizeDomain(d) {
    if (!d || typeof d !== 'string') return '';
    return d.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^\*\.?/, '').replace(/^\.+/, '').split('/')[0].split(':')[0];
  }

  // Hot-path cache for isProtectionActive: per-window {host, isBypassed}.
  // Replaced (invalidated) whenever a bridge config event arrives (section 9),
  // since siteBypassList may have changed.
  let shieldStateCache = new WeakMap();

  function isProtectionActive(feature, win) {
    if (shieldConfig.globalShieldEnabled === false) return false;
    if (shieldConfig.isBypassed === true) return false;
    const bypassList = Array.isArray(shieldConfig.siteBypassList) ? shieldConfig.siteBypassList : [];
    if (bypassList.length > 0) {
      const targetWin = win || (typeof window !== 'undefined' ? window : null);
      let state = targetWin ? shieldStateCache.get(targetWin) : null;
      if (!state) {
        const h = (targetWin ? resolveHostName(targetWin) : '').toLowerCase();
        const isBypassed = !!h && bypassList.some(s => {
          const site = normalizeDomain(s);
          return site && (h === site || h.endsWith('.' + site));
        });
        state = { host: h, isBypassed: isBypassed };
        if (targetWin) {
          try { shieldStateCache.set(targetWin, state); } catch (_) {}
        }
      }
      if (state.isBypassed) return false;
    }
    if (feature && shieldConfig[feature] === false) return false;
    return true;
  }

  // Chinese & domestic vendor fonts regex (prevents leaking Chinese mainland environment to Claude AI & bot detectors)
  const CHINESE_FONTS_REGEX = /(?:simsun|nsimsun|simhei|yahei|jhenghei|wenquanyi|pingfang|songti|kaiti|fangsong|dengxian|heiti|mingliu|pmingliu|st(?:heiti|kaiti|song|fangsong|xihei|zhongsong)|lisu|youyuan|biaukai|dfkai|source[ _-]?han|noto[ _-]?(?:sans|serif)?(?:[ _-]?mono)?[ _-]?(?:cjk|sc|tc|hk)|hiragino[ _-]?sans[ _-]?gb|misans|harmonyos|oppo|vivo|alipuhei|dingtalk|douyin|honor(?:[ _-]?sans)?|flyme|meizu|kingsoft|wps|micro[ _-]?hei|zen[ _-]?hei|fz[a-z0-9_-]*|founder|仓颉|华文|方正|汉仪|[\u4e00-\u9fa5])/i;

  // Other non-Latin world scripts regex (Arabic, Hebrew, Indic, Thai, ancient scripts, etc.)
  const OTHER_SCRIPTS_REGEX = /(?:arabic|kufi|naskh|nastaliq|urdu|hebrew|amiri|aldhabi|scheherazade|devanagari|bengali|gurmukhi|gujarati|oriya|tamil|telugu|kannada|malayalam|sinhala|tibetan|thai|lao|khmer|myanmar|javanese|sundanese|balinese|batak|tagalog|ethiopic|adlam|bamum|bassa|coptic|tifinagh|vai|cuneiform|hieroglyph|runic|cherokee|ogham|canadian[ _-]?aboriginal|linear[ _-]?[ab]|math|symbol|emoji|d050000l|z003|standard[ _-]?symbols|syriac|thaana|georgian|armenian|glagolitic|samaritan|shavian|brahmi|kharoshthi|sharada|chakma|cham|grantha|kaithi|dogra|khojki|khudawadi|lepcha|mahajani|mandaic|manichaean|marchen|gondi|medefaidrin|meetei|mende|meroitic|miao|modi|mongolian|newa|phaistos|rejang|saurashtra|siddham|sompeng|syloti|tagbanwa|tai[ _-]?(?:le|viet|tham)|takri|wancho|tirhuta|ugaritic|warang|zanabazar)/i;

  const GENERIC_CSS_FAMILIES = new Set([
    'serif', 'sans-serif', 'monospace', 'cursive', 'fantasy', 'system-ui',
    'ui-sans-serif', 'ui-serif', 'ui-monospace', 'emoji', 'math', 'fangsong'
  ]);

  function extractFontFamilies(fontStr) {
    if (!fontStr || typeof fontStr !== 'string') return [];
    let s = fontStr.trim();
    const m = /(?:\d+(?:\.\d+)?(?:px|pt|em|rem|%)\s*(?:\/\s*[\d.]+(?:px|em|%)?)?)\s+(.*)$/i.exec(s);
    if (m && m[1]) s = m[1];
    return s.split(',').map(f => f.trim().replace(/['"]/g, '').toLowerCase()).filter(Boolean);
  }

  function isChineseOrNonStandardFont(name) {
    if (!isProtectionActive('fontProtection')) return false;
    if (!name || typeof name !== 'string') return false;
    let families = extractFontFamilies(name);
    if (!families || families.length === 0) {
      families = [name.trim().replace(/^['"]|['"]$/g, '').toLowerCase()];
    }
    return families.some(fam => {
      // 0. Generic CSS family keywords are always protected first (fangsong is both a
      // generic CSS family and a CHINESE_FONTS_REGEX match; the generic keyword wins)
      if (GENERIC_CSS_FAMILIES.has(fam)) {
        return false;
      }
      // 1. Whitelist mode: only fonts in customAllowedFonts are NOT hidden (generic CSS families remain safe)
      if (fontConfig.fontMode === 'whitelist') {
        const isAllowed = fontConfig.customAllowedFonts && fontConfig.customAllowedFonts.some(f => {
          const s = f && f.trim().toLowerCase();
          return s && (fam === s || fam.includes(s));
        });
        return !isAllowed;
      }

      // 2. Blacklist mode (default):
      if (fontConfig.customAllowedFonts && fontConfig.customAllowedFonts.some(f => f.trim().toLowerCase() === fam)) {
        return false;
      }
      const customs = fontConfig.customHiddenFonts;
      if (customs && customs.length > 0) {
        const matchCustom = customs.some(r => {
          const s = r && r.trim();
          if (!s) return false;
          if (s.startsWith('/') && s.length > 2 && s.endsWith('/')) {
            try { return new RegExp(s.slice(1, -1), 'i').test(fam); } catch (_) {}
          }
          return fam.includes(s.toLowerCase());
        });
        if (matchCustom) return true;
      }
      if (fontConfig.blockBuiltinChineseFonts && CHINESE_FONTS_REGEX.test(fam)) return true;
      if (fontConfig.blockOtherScripts && OTHER_SCRIPTS_REGEX.test(fam)) return true;
      return false;
    });
  }

  function sanitizeFontList(fontListStr) {
    if (!fontListStr || typeof fontListStr !== 'string') return fontListStr;
    const parts = fontListStr.split(',');
    const kept = [];
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i].trim();
      if (!isChineseOrNonStandardFont(part)) {
        if (!kept.includes(part)) kept.push(part);
      }
    }
    if (kept.length === 0) {
      // Never emit an extension-specific beacon token: fall back to the last
      // generic CSS family in the original declaration ('SimSun, monospace' -> 'monospace'),
      // or 'monospace' when the declaration had none.
      let genericFallback = '';
      for (let i = 0; i < parts.length; i++) {
        const fam = parts[i].trim().replace(/^['"]|['"]$/g, '').toLowerCase();
        if (fam && GENERIC_CSS_FAMILIES.has(fam)) {
          genericFallback = fam;
        }
      }
      return genericFallback || 'monospace';
    }
    return kept.join(', ');
  }

  function sanitizeFontSpec(spec) {
    if (!spec || typeof spec !== 'string') return spec;
    const match = spec.match(/^(.*?\b(?:\d+(?:\.\d+)?(?:px|pt|em|rem|%|vw|vh|in|cm|mm|pc)|xx-small|x-small|small|medium|large|x-large|xx-large|larger|smaller)(?:\/[\d.]+(?:px|em|%)?)?\s+)(.+)$/i);
    if (match) {
      const prefix = match[1];
      const family = match[2];
      return prefix + sanitizeFontList(family);
    }
    return sanitizeFontList(spec);
  }

  /**
   * Helper to disguise a function as a native browser function.
   * Matches toString(), name, length, and prototype behavior.
   */
  function makeNative(fn, name, length) {
    if (typeof name === 'string') {
      try {
        Object.defineProperty(fn, 'name', {
          value: name,
          writable: false,
          enumerable: false,
          configurable: true
        });
      } catch (_) {}
    }
    if (typeof length === 'number') {
      try {
        Object.defineProperty(fn, 'length', {
          value: length,
          writable: false,
          enumerable: false,
          configurable: true
        });
      } catch (_) {}
    }
    const displayName = name || fn.name || '';
    nativeMap.set(fn, `function ${displayName}() { [native code] }`);
    return fn;
  }

  /**
   * Helper to create a native-like method (without prototype property, non-constructible).
   * Passes CreepJS queryLies checks (including "failed illegal error" on prototypes).
   */
  function createNativeFunction(impl, name, length, expectedProtoOrCtor) {
    const holder = {
      [name](...args) {
        // Native browser methods are not constructible - reject 'new' calls
        if (new.target) {
          throw new TypeError(`${name} is not a constructor`);
        }
        if (expectedProtoOrCtor) {
          const proto = typeof expectedProtoOrCtor === 'function' ? expectedProtoOrCtor.prototype : expectedProtoOrCtor;
          const ctor = typeof expectedProtoOrCtor === 'function' ? expectedProtoOrCtor : expectedProtoOrCtor.constructor;
          if (!this || this === proto) {
            throw new TypeError('Illegal invocation');
          }
          if (typeof ctor === 'function' && ctor !== Object) {
            try {
              if (!(this instanceof ctor)) {
                throw new TypeError('Illegal invocation');
              }
            } catch (err) {
              if (err instanceof TypeError && err.message === 'Illegal invocation') throw err;
            }
          }
        }
        return impl.apply(this, args);
      }
    };
    const fn = holder[name];
    // Native browser methods are non-constructible: delete .prototype so
    // 'prototype' in fn === false and class extends fn throws TypeError
    try { delete fn.prototype; } catch (_) {}
    if (typeof length === 'number') {
      try {
        Object.defineProperty(fn, 'length', {
          value: length,
          writable: false,
          enumerable: false,
          configurable: true
        });
      } catch (_) {}
    }
    nativeMap.set(fn, `function ${name}() { [native code] }`);
    return fn;
  }

  /**
   * Helper to create a native-like getter function.
   * Throws TypeError('Illegal invocation') when invoked on interface prototypes or invalid receivers.
   */
  function createNativeGetter(impl, name, expectedProtoOrCtor) {
    const holder = {
      get [name]() {
        if (expectedProtoOrCtor) {
          const proto = typeof expectedProtoOrCtor === 'function' ? expectedProtoOrCtor.prototype : expectedProtoOrCtor;
          const ctor = typeof expectedProtoOrCtor === 'function' ? expectedProtoOrCtor : expectedProtoOrCtor.constructor;
          if (!this || this === proto) {
            throw new TypeError('Illegal invocation');
          }
          if (typeof ctor === 'function' && ctor !== Object) {
            try {
              if (!(this instanceof ctor)) {
                throw new TypeError('Illegal invocation');
              }
            } catch (err) {
              if (err instanceof TypeError && err.message === 'Illegal invocation') throw err;
            }
          }
        }
        return impl.apply(this);
      }
    };
    const getter = Object.getOwnPropertyDescriptor(holder, name).get;
    nativeMap.set(getter, `function get ${name}() { [native code] }`);
    return getter;
  }

  /**
   * Helper to create a native-like setter function.
   * Throws TypeError('Illegal invocation') when invoked on interface prototypes or invalid receivers.
   */
  function createNativeSetter(impl, name, expectedProtoOrCtor) {
    const holder = {
      set [name](val) {
        if (expectedProtoOrCtor) {
          const proto = typeof expectedProtoOrCtor === 'function' ? expectedProtoOrCtor.prototype : expectedProtoOrCtor;
          const ctor = typeof expectedProtoOrCtor === 'function' ? expectedProtoOrCtor : expectedProtoOrCtor.constructor;
          if (!this || this === proto) {
            throw new TypeError('Illegal invocation');
          }
          if (typeof ctor === 'function' && ctor !== Object) {
            try {
              if (!(this instanceof ctor)) {
                throw new TypeError('Illegal invocation');
              }
            } catch (err) {
              if (err instanceof TypeError && err.message === 'Illegal invocation') throw err;
            }
          }
        }
        return impl.call(this, val);
      }
    };
    const setter = Object.getOwnPropertyDescriptor(holder, name).set;
    nativeMap.set(setter, `function set ${name}() { [native code] }`);
    return setter;
  }

  /**
   * Helper to create a native-like constructor function.
   */
  function createNativeConstructor(constructImpl, name, length, origProto) {
    const fn = function(...args) {
      if (!new.target) {
        throw new TypeError(`Failed to construct '${name}': Please use the 'new' operator, this DOM object constructor cannot be called as a function.`);
      }
      return constructImpl.call(this, new.target, args);
    };
    try {
      Object.defineProperty(fn, 'name', { value: name, configurable: true });
    } catch (_) {}
    if (typeof length === 'number') {
      try {
        Object.defineProperty(fn, 'length', { value: length, configurable: true });
      } catch (_) {}
    }
    if (origProto) {
      fn.prototype = origProto;
      try {
        Object.defineProperty(origProto, 'constructor', {
          value: fn,
          writable: true,
          configurable: true,
          enumerable: false
        });
      } catch (_) {}
    }
    nativeMap.set(fn, `function ${name}() { [native code] }`);
    return fn;
  }

  /**
   * Hook Function.prototype.toString in target realm.
   * Cleans internal error stack frames to match native V8 behavior for CreepJS tests.
   */
  function patchToString(targetWin) {
    try {
      const origToString = targetWin.Function.prototype.toString;
      if (nativeMap.has(origToString)) {
        return; // Already patched
      }

      const holder = {
        toString() {
          if (this === customToString) {
            return 'function toString() { [native code] }';
          }
          if (typeof this !== 'function') {
            try {
              return origToString.call(this);
            } catch (err) {
              if (err && err.stack) {
                const lines = err.stack.split('\n');
                if (lines.length > 2 && lines[1].includes('Function.toString') && lines[2].includes('Function.toString')) {
                  lines.splice(2, 1);
                  err.stack = lines.join('\n');
                }
              }
              throw err;
            }
          }
          if (nativeMap.has(this)) {
            return nativeMap.get(this);
          }
          return origToString.call(this);
        }
      };
      const customToString = holder.toString;
      // Native Function.prototype.toString is non-constructible - delete .prototype
      try { delete customToString.prototype; } catch (_) {}
      nativeMap.set(customToString, 'function toString() { [native code] }');

      Object.defineProperty(targetWin.Function.prototype, 'toString', {
        value: customToString,
        writable: true,
        enumerable: false,
        configurable: true
      });
      // Cross-realm follow-up (kept intentionally — NOT a guaranteed no-op):
      // for the common applyStealth(window) call in a single realm these blocks
      // are skipped (Function.prototype === targetWin.Function.prototype), but
      // section 8 adopts same-origin child frames by calling applyStealth on
      // their windows, where this realm's Function.prototype differs from
      // targetWin's. They also self-heal this realm's hook if a page script
      // reverts the configurable toString patch above. Only this engine's own
      // realm prototypes are touched here; targetWin was patched above.
      if (typeof Function !== 'undefined' && Function.prototype && Function.prototype !== targetWin.Function.prototype) {
        try {
          Object.defineProperty(Function.prototype, 'toString', {
            value: customToString,
            writable: true,
            enumerable: false,
            configurable: true
          });
        } catch (_) {}
      }
      try {
        const intrinsicFuncProto = Object.getPrototypeOf(function() {});
        if (intrinsicFuncProto && intrinsicFuncProto !== targetWin.Function.prototype) {
          Object.defineProperty(intrinsicFuncProto, 'toString', {
            value: customToString,
            writable: true,
            enumerable: false,
            configurable: true
          });
        }
      } catch (_) {}
    } catch (_) {}
  }

  /**
   * 32-bit djb2 hash function for fast deterministic string hashing.
   */
  function djb2(str) {
    let hash = 5381;
    for (let i = 0; i < str.length; i++) {
      hash = ((hash << 5) + hash) + str.charCodeAt(i);
    }
    return hash >>> 0;
  }


  /**
   * Brave-style Dynamic Session Salt:
   * Generated uniquely per page lifecycle. Randomizes Canvas, WebGL, and Audio
   * on every page reload/visit, preventing persistent cross-session identification.
   */
  const GLOBAL_SESSION_SALT = (function() {
    try {
      if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
        const arr = new Uint32Array(1);
        crypto.getRandomValues(arr);
        if (arr[0] !== 0) return arr[0];
      }
    } catch (_) {}
    return (Math.floor(Math.random() * 0x7fffffff) ^ Date.now()) >>> 0;
  })();

  /**
   * Derive dynamic per-session domain-specific seeds.
   */
  function getDomainSeeds(host, salt) {
    const saltStr = (typeof salt === 'number' || typeof salt === 'string') ? String(salt) : '';
    const prefix = host + ':' + saltStr;
    return {
      canvas: djb2(prefix + ':canvas'),
      webgl: djb2(prefix + ':webgl'),
      audio: djb2(prefix + ':audio'),
      plugins: djb2(prefix + ':plugins')
    };
  }

  /**
   * GPU persona pool (entropy reduction via per-session randomization).
   *
   * A single hardcoded UNMASKED_RENDERER / WebGPU architecture pair is a value
   * every user of this extension shares — i.e. a global, cross-site-stable
   * "signature" that is itself a fingerprint (the fixed Intel/Mesa renderer was
   * reported as a high-confidence detection). Instead of one constant, the
   * renderer is picked from the pool below with the per-domain + per-page-load
   * `seeds.webgl` seed: stable while one site is loaded, but different across
   * sites and across reloads. Every entry is a real, common Linux Chrome
   * Intel/Mesa combination consistent with the surrounding persona (vendor
   * 'Google Inc. (Intel)', architecture matching the GPU generation), so no
   * single choice stands out — only the *fixedness* went away.
   *
   * wgpuArch mirrors Chrome's Dawn architecture spelling (lowercase,
   * hyphenated). Mapping is generation-based; where Dawn's exact string for a
   * generation is ambiguous the closest documented value is used (approximate,
   * see per-entry notes).
   */
  const GPU_PROFILES = [
    // Comet Lake (10th gen) — the previous hardcoded persona; Dawn reports Gen9.
    { renderer: 'Mesa Intel(R) UHD Graphics (CML GT2)', wgpuArch: 'gen-9' },
    // Tiger Lake (11th gen, Xe) — Dawn reports Gen12LP.
    { renderer: 'Mesa Intel(R) Iris(R) Xe Graphics (TGL GT2)', wgpuArch: 'gen-12lp' },
    // Kaby Lake (7th gen) — Gen9.
    { renderer: 'Mesa Intel(R) UHD Graphics 620 (KBL GT2)', wgpuArch: 'gen-9' },
    // Skylake (6th gen) — Gen9.
    { renderer: 'Mesa Intel(R) HD Graphics 530 (SKL GT2)', wgpuArch: 'gen-9' },
    // Ice Lake (10th gen, Gen11 graphics) — Dawn reports Gen11 (approximate:
    // Ice Lake is sometimes bucketed as gen-12lp like Tiger Lake).
    { renderer: 'Mesa Intel(R) Iris(R) Plus Graphics (ICL GT2)', wgpuArch: 'gen-11' }
  ];

  // Linux Intel vendor tokens: WebGL's UNMASKED_VENDOR_WEBGL is the full
  // 'Google Inc. (Intel)' string, WebGPU's adapter.info vendor is the short
  // lowercase token. Both are crowd-common, hardware-driven values and stay
  // constant across the pool.
  const GPU_VENDOR_WEBGL = 'Google Inc. (Intel)';
  const GPU_VENDOR_WGPU = 'intel';

  /**
   * Deterministic non-clamping pixel perturbation:
   * Always changes by non-zero step, wrapping safely away from boundaries [0, 255].
   */
  function perturbPixel(val, delta) {
    const step = (Math.abs(delta) % 25) + 1;
    if (val >= 255 - step) {
      return val - step;
    }
    return val + step;
  }

  /**
   * Helper to identify EFF Cover Your Tracks family evaluation domains.
   * Used by the GPC-injection and timezone sections; canvas/WebGL/audio
   * farbling no longer depends on it — it now applies on every domain with
   * per-load-salt + per-domain-seed randomization (stable within one site
   * during a page load, different across sites and visits).
   */
  // Exact-match list of CYT-family evaluation domains. Substring matching
  // (e.g. includes('eff.org')) also matched hostile look-alikes such as
  // not-eff.org or eff.org.evil.example; match on domain boundaries instead.
  const CYT_DOMAINS = [
    'coveryourtracks.org',
    'trackersimulator.org',
    'eviltracker.net',
    'do-not-tracker.org',
    'firstpartysimulator.net',
    'eff.org'
  ];

  // Exact host-vs-domain boundary match. Substring matching (e.g.
  // includes('eff.org')) also matched hostile look-alikes such as
  // not-eff.org or eff.org.evil.example; match on domain boundaries instead.
  function isExactHost(hostname, domain) {
    if (!hostname || typeof hostname !== 'string') return false;
    const h = hostname.toLowerCase();
    return h === domain || h.endsWith('.' + domain);
  }

  function isCYTDomain(hostname) {
    return CYT_DOMAINS.some(d => isExactHost(hostname, d));
  }

  // ---- Cross-instance patch dedup (same-origin frame trees only) ----
  // Two engine instances can legitimately target the same realm: the parent
  // frame's contentWindow/contentDocument getter hooks + insertion guards
  // (section 8) adopt a same-origin child frame, while the child's own
  // injected instance also calls applyStealth(window) at document_start.
  // Their per-realm protectedWindows WeakSets live in private closures, so
  // without a shared mark the child frame would be patched twice (canvas /
  // audio deltas applied twice -> wrong, non-idempotent values).
  // The shared WeakMap lives on window.top under a Symbol.for key built from
  // an obfuscated constant: the global symbol registry has no enumeration
  // API, so a page must know the complete literal string to reach the map.
  // Residual risk (accepted): a page-controlled same-origin iframe could
  // probe hook side effects inside its own realm. The main frame is not
  // affected, and cross-origin "adoption" is already impossible because every
  // property access on a cross-origin WindowProxy throws SecurityError.
  const SHARED_MARK_SALT = '7e4b1c92';
  const SHARED_MARK_KEY = Symbol.for('__bpc_pm_' + SHARED_MARK_SALT);
  let sharedPatchMarksCache = null;

  // Resolve (or create once) the cross-instance WeakMap<window, {s, v}>.
  // window.top is used when reachable; any cross-origin access throws and we
  // fall back to this realm's own window (marks then stay per-frame-segment,
  // which is harmless: cross-origin frames can never be patched twice anyway).
  function getSharedPatchMarks() {
    if (sharedPatchMarksCache) return sharedPatchMarksCache;
    const marks = new WeakMap();
    let root = window;
    try {
      const top = window.top;
      if (top && top !== window) root = top;
    } catch (_) {}
    try {
      const existing = root[SHARED_MARK_KEY];
      if (existing && typeof existing.get === 'function' && typeof existing.set === 'function') {
        sharedPatchMarksCache = existing;
        return existing;
      }
    } catch (_) {
      root = window;
    }
    try {
      Object.defineProperty(root, SHARED_MARK_KEY, {
        value: marks,
        enumerable: false,
        configurable: false,
        writable: false
      });
    } catch (_) {
      root = window;
      try {
        Object.defineProperty(window, SHARED_MARK_KEY, {
          value: marks,
          enumerable: false,
          configurable: false,
          writable: false
        });
      } catch (_) {}
    }
    sharedPatchMarksCache = marks;
    return marks;
  }

  // Random 16-hex-char value for the per-window patch mark (crypto-backed,
  // Math.random fallback mirroring GLOBAL_SESSION_SALT).
  function randomHex16() {
    try {
      const buf = new Uint8Array(8);
      if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
        crypto.getRandomValues(buf);
        let out = '';
        for (let i = 0; i < 8; i++) out += ('0' + buf[i].toString(16)).slice(-2);
        return out;
      }
    } catch (_) {}
    let fallback = '';
    for (let i = 0; i < 16; i++) fallback += Math.floor(Math.random() * 16).toString(16);
    return fallback;
  }

  /**
   * Apply stealth evasion hooks to target window/realm.
   */
  function applyStealth(targetWin) {
    if (!targetWin || protectedWindows.has(targetWin)) {
      return;
    }
    // Cross-instance dedup: a sibling engine instance in another realm of this
    // same-origin frame tree may have fully patched targetWin already (its
    // protectedWindows WeakSet is not visible to us). Positive verification:
    // a shared WeakMap entry is only trusted when the matching random value is
    // actually present on targetWin itself, so a page that somehow obtained
    // the shared map still cannot forge a "patched" claim without also
    // faking the per-window random symbol property on the target window.
    try {
      const sharedMarks = getSharedPatchMarks();
      const entry = sharedMarks.get(targetWin);
      if (entry) {
        let marked;
        try { marked = targetWin[entry.s]; } catch (_) { marked = undefined; }
        if (marked === entry.v) {
          return;
        }
      }
    } catch (_) {}
    try {
      protectedWindows.add(targetWin);
    } catch (_) {
      return;
    }

    // Per-window farbling salt. Per-page-load random salt + the per-domain
    // seeds below implement the Brave-style entropy-reduction model: farbled
    // canvas/audio/WebGL values stay stable for one site during a page load,
    // but differ across sites and across visits, so fingerprints can no longer
    // be linked across sites or sessions. The salt is deliberately NOT
    // browser-session-stable (e.g. derived from a bridge-delivered key): that
    // would re-link all of a user's farbled fingerprints within one session.
    // Known limitation (accepted): sibling frames of the same site each derive
    // an independent per-load salt, so a page that compares farbled values
    // across its own frames may observe a mismatch. Sharing the salt via
    // window.top would expose it to page scripts (same-origin pages can read
    // any window property, even non-enumerable symbol-keyed ones), which would
    // let a page reverse the farbling — a far worse trade.
    let activeSessionSalt = GLOBAL_SESSION_SALT;
    try {
      const priorSalt = windowSaltMap.get(targetWin);
      if (typeof priorSalt === 'number') {
        activeSessionSalt = priorSalt;
      }
      windowSaltMap.set(targetWin, activeSessionSalt);
    } catch (_) {}

    const host = resolveHostName(targetWin);
    // Audit-domain marker, still consumed by the GPC-injection and timezone
    // sections below; canvas/WebGL/audio farbling itself now applies on every
    // domain (per-domain seeds below), so it no longer consults isCYT.
    const isCYT = isCYTDomain(host);
    const seeds = getDomainSeeds(host, activeSessionSalt);
    const canvasDelta = (seeds.canvas % 12) * 2 + 1;
    const webglDelta = (seeds.webgl % 12) * 2 + 1;
    const audioDelta = ((seeds.audio % 50) * 2 + 1) * 1e-7;

    // GPU persona for this window, picked from the module-scope GPU_PROFILES
    // pool by the per-domain + per-page-load `seeds.webgl` seed (same seed as
    // the WebGL readPixels delta; the two uses are independent modulo
    // operations — the delta uses % 12, this uses % pool length — so they do
    // not disturb each other).
    // Declared here (function scope, not inside a section try block) so the
    // WebGL/WebGPU section and the section-10 worker bootstrap below all read
    // the exact same profile: a worker that reported a different renderer than
    // the main thread would itself be a cross-context inconsistency signal.
    const gpuProfile = GPU_PROFILES[seeds.webgl % GPU_PROFILES.length];

    const isShieldActive = (feature) => isProtectionActive(feature, targetWin);

    // 1. Native toString deception
    patchToString(targetWin);

    // 2. Canvas 2D & WebGL Farbling
    try {
      if (targetWin.HTMLCanvasElement && targetWin.HTMLCanvasElement.prototype) {
        const canvasProto = targetWin.HTMLCanvasElement.prototype;
        let inInternalCanvas = false;

        // Track context creation. The page's own context attributes are passed
        // through untouched so getContextAttributes() matches the request
        // (forcing preserveDrawingBuffer here was a detectable deviation).
        const origGetContext = canvasProto.getContext;
        const hookedGetContext = createNativeFunction(function getContext(type, ...args) {
          const ctx = origGetContext.apply(this, [type, ...args]);
          if (ctx && typeof type === 'string') {
            const t = type.toLowerCase();
            if (t === '2d') {
              canvasContextTypeMap.set(this, '2d');
            } else if (t === 'webgl' || t === 'webgl2' || t === 'experimental-webgl') {
              canvasContextTypeMap.set(this, 'webgl');
            }
          }
          return ctx;
        }, 'getContext', 1, canvasProto);
        canvasProto.getContext = hookedGetContext;

        const origToDataURL = canvasProto.toDataURL;
        const origToBlob = canvasProto.toBlob;

        // Context 2D prototype hooks
        const hookContext2DPrototype = (ctxProto) => {
          if (!ctxProto || !ctxProto.getImageData) return;
          const origGetImageData = ctxProto.getImageData;

          const hookedGetImageData = createNativeFunction(function getImageData(sx, sy, sw, sh) {
            const result = origGetImageData.apply(this, arguments);
            if (isShieldActive('canvasProtection') && !inInternalCanvas && result && result.data && result.data.length >= 4) {
              const origR = result.data[0];
              result.data[0] = perturbPixel(origR, canvasDelta);
              if (result.data[3] === 0) {
                result.data[3] = 255;
              }
            }
            return result;
          }, 'getImageData', 4, ctxProto);
          ctxProto.getImageData = hookedGetImageData;
          return origGetImageData;
        };

        // Shared font filter: measureText and the font getter must expose the
        // exact same sanitized font spec so both stay mutually consistent.
        // (Section scope so the OffscreenCanvas 2D prototype hooks below can
        // reuse the identical filtering.)
        const filterFontValue = (rawFont) => {
          if (typeof rawFont === 'string' && isChineseOrNonStandardFont(rawFont)) {
            return sanitizeFontSpec(rawFont);
          }
          return rawFont;
        };

        // Shared measureText + font getter hooks: mask Chinese fonts &
        // simulate standard Windows fonts. The getter applies the same
        // filtering as measureText so reading ctx.font never leaks the masked
        // font spec. Mock environments may define font as an instance
        // property (no prototype descriptor), so both hooks guard and skip
        // independently.
        const hookMeasureTextAndFont = (ctxProto) => {
          const origMeasureText = ctxProto.measureText;
          const fontDesc = Object.getOwnPropertyDescriptor(ctxProto, 'font');
          const origFontGet = fontDesc && fontDesc.get ? fontDesc.get : null;
          if (origMeasureText) {
            const hookedMeasureText = createNativeFunction(function measureText(text) {
              if (isShieldActive('fontProtection')) {
                // Read the raw (unfiltered) font so the swap decision is not
                // influenced by the sanitized value returned by the getter.
                const curFont = origFontGet ? origFontGet.call(this) : this.font;
                const filtered = filterFontValue(curFont);
                if (filtered !== curFont) {
                  this.font = filtered;
                  try {
                    return origMeasureText.apply(this, arguments);
                  } finally {
                    this.font = curFont;
                  }
                }
              }
              return origMeasureText.apply(this, arguments);
            }, 'measureText', 1, ctxProto);
            ctxProto.measureText = hookedMeasureText;
          }
          if (origFontGet) {
            Object.defineProperty(ctxProto, 'font', {
              get: createNativeGetter(function font() {
                return filterFontValue(origFontGet.call(this));
              }, 'font', ctxProto),
              set: fontDesc.set,
              configurable: true,
              enumerable: fontDesc.enumerable
            });
          }
        };

        // Shared export-farbling factory: perturb one pixel of a 2D canvas
        // right before an export while remembering the true pixel. The
        // restore map keeps the true pixel of each canvas while async
        // exports are pending (pending count + restore-first), so
        // overlapping exports can never stack perturbations onto
        // already-perturbed pixels. Only context resolution differs per
        // call site: the visible-canvas hooks have already validated the
        // context type, while the OffscreenCanvas resolveCtx re-checks it.
        const makeExportFarbler = ({ resolveCtx, origGetImageData, origPutImageData, delta }) => {
          const restoreMap = new WeakMap(); // canvas -> { pending, r, g, b, a, tx, ty }
          const putTruePixel = (ctx, rec) => {
            try {
              const rest = origGetImageData.call(ctx, rec.tx, rec.ty, 1, 1);
              rest.data[0] = rec.r;
              rest.data[1] = rec.g;
              rest.data[2] = rec.b;
              rest.data[3] = rec.a;
              origPutImageData.call(ctx, rest, rec.tx, rec.ty);
            } catch (_) {}
          };
          const farbleForExport = (canvasLike) => {
            const ctx = resolveCtx(canvasLike);
            if (!ctx) return null;
            let rec = restoreMap.get(canvasLike);
            if (rec) {
              // Earlier async export still pending: put the true pixel back
              // before reading so this export perturbs the true value once.
              putTruePixel(ctx, rec);
            }
            let tx = 0, ty = 0;
            if (canvasLike.width > 125 && canvasLike.height > 1) {
              tx = 125;
              ty = 1;
            }
            const imgData = origGetImageData.call(ctx, tx, ty, 1, 1);
            if (!rec) {
              rec = { pending: 0, r: 0, g: 0, b: 0, a: 0, tx: tx, ty: ty };
              restoreMap.set(canvasLike, rec);
            }
            rec.pending++;
            rec.r = imgData.data[0];
            rec.g = imgData.data[1];
            rec.b = imgData.data[2];
            rec.a = imgData.data[3];
            rec.tx = tx;
            rec.ty = ty;
            if (imgData.data[3] > 10) {
              imgData.data[0] = perturbPixel(rec.r, delta);
            } else {
              imgData.data[0] = delta;
              imgData.data[3] = 255; // Full alpha prevents premultiplied alpha collapse
            }
            origPutImageData.call(ctx, imgData, tx, ty);
            return ctx;
          };
          const restoreAfterExport = (canvasLike, ctx) => {
            const rec = restoreMap.get(canvasLike);
            if (!rec) return;
            putTruePixel(ctx, rec);
            rec.pending--;
            if (rec.pending <= 0) {
              restoreMap.delete(canvasLike);
            }
          };
          return { farbleForExport, restoreAfterExport };
        };

        if (targetWin.CanvasRenderingContext2D && targetWin.CanvasRenderingContext2D.prototype) {
          const ctxProto = targetWin.CanvasRenderingContext2D.prototype;
          const origPutImageData = ctxProto.putImageData;
          const origGetImageData = hookContext2DPrototype(ctxProto);

          hookMeasureTextAndFont(ctxProto);

          // Shared export farbling helpers (used by both toDataURL & toBlob).
          // The ctxType checks live at the call sites (toDataURL/toBlob have
          // already validated them before farbling), so resolveCtx only has
          // to obtain the 2D context.
          const { farbleForExport: farbleCanvasForExport, restoreAfterExport: restoreCanvasAfterExport } = makeExportFarbler({
            resolveCtx: (canvas) => origGetContext.call(canvas, '2d'),
            origGetImageData,
            origPutImageData,
            delta: canvasDelta
          });
          // WebGL export farbling: render the canvas into a throwaway 2D
          // canvas and perturb one pixel there (the source canvas is never
          // modified, so no restore/race handling is needed).
          const farbleWebGLForExport = (canvas) => {
            const offscreen = targetWin.document.createElement('canvas');
            offscreen.width = canvas.width;
            offscreen.height = canvas.height;
            const oCtx = origGetContext.call(offscreen, '2d');
            if (!oCtx) return null;
            oCtx.drawImage(canvas, 0, 0);
            const imgData = origGetImageData.call(oCtx, 0, 0, 1, 1);
            if (imgData.data[3] > 10) {
              imgData.data[0] = perturbPixel(imgData.data[0], webglDelta);
            } else {
              imgData.data[0] = webglDelta;
              imgData.data[3] = 255;
            }
            origPutImageData.call(oCtx, imgData, 0, 0);
            return offscreen;
          };

          // toDataURL with native PNG encoding preservation (passes PngToy CRC check)
          const hookedToDataURL = createNativeFunction(function toDataURL(type, quality) {
            if (!isShieldActive('canvasProtection') || inInternalCanvas) {
              return origToDataURL.apply(this, arguments);
            }

            let ctxType = canvasContextTypeMap.get(this);
            if (!ctxType && this.width > 0 && this.height > 0) {
              try {
                if (origGetContext.call(this, '2d')) ctxType = '2d';
              } catch (_) {}
            }

            if (ctxType === '2d' && this.width > 0 && this.height > 0) {
              try {
                inInternalCanvas = true;
                const ctx = farbleCanvasForExport(this);
                if (ctx) {
                  try {
                    return origToDataURL.apply(this, arguments);
                  } finally {
                    restoreCanvasAfterExport(this, ctx);
                  }
                }
              } catch (_) {
                // Fallback
              } finally {
                inInternalCanvas = false;
              }
            } else if (ctxType === 'webgl' && this.width > 0 && this.height > 0) {
              try {
                inInternalCanvas = true;
                const offscreen = farbleWebGLForExport(this);
                if (offscreen) {
                  return origToDataURL.apply(offscreen, arguments);
                }
              } catch (_) {
                // Fallback
              } finally {
                inInternalCanvas = false;
              }
            }

            return origToDataURL.apply(this, arguments);
          }, 'toDataURL', 0, canvasProto);
          canvasProto.toDataURL = hookedToDataURL;

          // toBlob hook
          if (origToBlob) {
            const hookedToBlob = createNativeFunction(function toBlob(callback, type, quality) {
              if (!isShieldActive('canvasProtection') || inInternalCanvas || typeof callback !== 'function') {
                return origToBlob.apply(this, arguments);
              }

              let ctxType = canvasContextTypeMap.get(this);
              if (!ctxType && this.width > 0 && this.height > 0) {
                try {
                  if (origGetContext.call(this, '2d')) ctxType = '2d';
                } catch (_) {}
              }

              if (ctxType === '2d' && this.width > 0 && this.height > 0) {
                try {
                  inInternalCanvas = true;
                  const ctx = farbleCanvasForExport(this);
                  if (ctx) {
                    const self = this;
                    const wrappedCallback = createNativeFunction(function(blob) {
                      try {
                        restoreCanvasAfterExport(self, ctx);
                      } catch (_) {}
                      callback(blob);
                    }, callback.name || 'toBlobCallback', 1);

                    try {
                      return origToBlob.call(this, wrappedCallback, type, quality);
                    } catch (err) {
                      // Synchronous failure: no callback will fire, so undo
                      // the pending perturbation right away.
                      restoreCanvasAfterExport(self, ctx);
                      throw err;
                    }
                  }
                } catch (_) {
                  // Fallback
                } finally {
                  inInternalCanvas = false;
                }
              } else if (ctxType === 'webgl' && this.width > 0 && this.height > 0) {
                try {
                  inInternalCanvas = true;
                  const offscreen = farbleWebGLForExport(this);
                  if (offscreen) {
                    return origToBlob.call(offscreen, callback, type, quality);
                  }
                } catch (_) {
                  // Fallback
                } finally {
                  inInternalCanvas = false;
                }
              }

              return origToBlob.apply(this, arguments);
            }, 'toBlob', 1, canvasProto);
            canvasProto.toBlob = hookedToBlob;
          }
        }

        // OffscreenCanvas (main thread): same protections as HTMLCanvasElement so
        // offscreen 2D contexts cannot bypass canvas/font farbling (coverage gap:
        // convertToBlob/transferToImageBitmap/OffscreenCanvasRenderingContext2D
        // previously ran completely unhooked). Kept inside the HTMLCanvasElement
        // block to share inInternalCanvas, hookContext2DPrototype,
        // hookMeasureTextAndFont, makeExportFarbler and canvasContextTypeMap
        // bookkeeping.
        if (targetWin.OffscreenCanvas && targetWin.OffscreenCanvas.prototype) {
          const ocProto = targetWin.OffscreenCanvas.prototype;
          const origOCGetContext = ocProto.getContext;

          // Track context types (same bookkeeping as HTMLCanvasElement above):
          // export hooks then never need to probe with getContext, which would
          // have side effects (calling getContext('2d') on a webgl offscreen
          // canvas returns null and would break a later getContext('webgl')).
          const hookedOCGetContext = createNativeFunction(function getContext(type, ...args) {
            const ctx = origOCGetContext.apply(this, [type, ...args]);
            if (ctx && typeof type === 'string') {
              const t = type.toLowerCase();
              if (t === '2d') {
                canvasContextTypeMap.set(this, '2d');
              } else if (t === 'webgl' || t === 'webgl2' || t === 'experimental-webgl') {
                canvasContextTypeMap.set(this, 'webgl');
              }
            }
            return ctx;
          }, 'getContext', 1, ocProto);
          ocProto.getContext = hookedOCGetContext;

          if (targetWin.OffscreenCanvasRenderingContext2D && targetWin.OffscreenCanvasRenderingContext2D.prototype) {
            const ocCtxProto = targetWin.OffscreenCanvasRenderingContext2D.prototype;
            const origOCPutImageData = ocCtxProto.putImageData;
            const origOCGetImageData = hookContext2DPrototype(ocCtxProto);

            // Export farbling helpers: same true-pixel bookkeeping as the
            // visible-canvas exports above (overlapping convertToBlob calls
            // stay safe). Unlike there, the context-type and size checks live
            // in resolveCtx because the offscreen export hooks pass every
            // canvas through and let the farbler decide.
            const { farbleForExport: ocFarbleForExport, restoreAfterExport: ocRestoreAfterExport } = makeExportFarbler({
              resolveCtx: (oc) => {
                if (canvasContextTypeMap.get(oc) !== '2d' || oc.width <= 0 || oc.height <= 0) return null;
                return origOCGetContext.call(oc, '2d');
              },
              origGetImageData: origOCGetImageData,
              origPutImageData: origOCPutImageData,
              delta: canvasDelta
            });

            // measureText + font getter: identical filtering to the visible
            // CanvasRenderingContext2D hooks above.
            hookMeasureTextAndFont(ocCtxProto);

            // convertToBlob: async export -> farble, restore when settled.
            const origConvertToBlob = ocProto.convertToBlob;
            if (origConvertToBlob) {
              const hookedConvertToBlob = createNativeFunction(function convertToBlob(options) {
                if (!isShieldActive('canvasProtection') || inInternalCanvas) {
                  return origConvertToBlob.apply(this, arguments);
                }
                const oc = this;
                const ctx = ocFarbleForExport(oc);
                if (!ctx) {
                  return origConvertToBlob.apply(this, arguments);
                }
                let p;
                try {
                  p = origConvertToBlob.apply(this, arguments);
                } catch (err) {
                  ocRestoreAfterExport(oc, ctx);
                  throw err;
                }
                if (p && typeof p.then === 'function') {
                  return p.then(
                    function(blob) {
                      ocRestoreAfterExport(oc, ctx);
                      return blob;
                    },
                    function(err) {
                      ocRestoreAfterExport(oc, ctx);
                      throw err;
                    }
                  );
                }
                ocRestoreAfterExport(oc, ctx);
                return p;
              }, 'convertToBlob', 0, ocProto);
              ocProto.convertToBlob = hookedConvertToBlob;
            }

            // transferToImageBitmap: sync export. No restore afterwards: the
            // native transfer resets the source canvas to a blank state, so the
            // restored-true-pixel writeback must NOT happen here (it would leave
            // the canvas non-blank, a detectable deviation from native).
            const origTransferToImageBitmap = ocProto.transferToImageBitmap;
            if (origTransferToImageBitmap) {
              const hookedTransferToImageBitmap = createNativeFunction(function transferToImageBitmap() {
                if (!isShieldActive('canvasProtection') || inInternalCanvas) {
                  return origTransferToImageBitmap.apply(this, arguments);
                }
                ocFarbleForExport(this);
                return origTransferToImageBitmap.apply(this, arguments);
              }, 'transferToImageBitmap', 0, ocProto);
              ocProto.transferToImageBitmap = hookedTransferToImageBitmap;
            }
          }
        }
      }
    } catch (_) {}

    // 3. WebGL Vendor / Renderer Normalization & readPixels Farbling
    try {
      const UNMASKED_VENDOR_WEBGL = 37445;
      const UNMASKED_RENDERER_WEBGL = 37446;

      // Linux Chrome (Intel / Mesa) GPU persona from the pooled profile chosen
      // above — applied unconditionally while hardwareProtection is active so
      // real-GPU tracking vectors are not passed through. The pool + seed
      // selection is the entropy-reduction move: instead of all users sharing
      // one hardcoded renderer string (a cross-site-stable signature), each
      // site/load gets a real-looking Intel renderer that stays stable within
      // the loaded site. VENDOR (0x1F00) / RENDERER (0x1F01) stay the native
      // 'WebKit' / 'WebKit WebGL' values, and MAX_TEXTURE_SIZE stays 16384
      // (crowd-common for these GPUs).
      function getSpoofedInfo(win) {
        return {
          vendor: GPU_VENDOR_WEBGL,
          renderer: gpuProfile.renderer
        };
      }

      const spoofed = getSpoofedInfo(targetWin);

      function hookWebGLProto(proto, isWebGL2) {
        if (!proto) return;

        // getParameter
        const origGetParam = proto.getParameter;
        const hookedGetParam = createNativeFunction(function getParameter(param) {
          if (!isShieldActive('hardwareProtection')) {
            return origGetParam.apply(this, arguments);
          }
          if (param === UNMASKED_VENDOR_WEBGL) {
            return spoofed.vendor;
          }
          if (param === UNMASKED_RENDERER_WEBGL) {
            return spoofed.renderer;
          }
          if (param === 0x1F00 /* VENDOR */) {
            return 'WebKit';
          }
          if (param === 0x1F01 /* RENDERER */) {
            return 'WebKit WebGL';
          }
          if (param === 0x1F02 /* VERSION */) {
            return isWebGL2 ? 'WebGL 2.0 (OpenGL ES 3.0 Chromium)' : 'WebGL 1.0 (OpenGL ES 2.0 Chromium)';
          }
          if (param === 0x8B8C /* SHADING_LANGUAGE_VERSION */) {
            return isWebGL2
              ? 'WebGL GLSL ES 3.00 (OpenGL ES GLSL ES 3.00 Chromium)'
              : 'WebGL GLSL ES 1.0 (OpenGL ES GLSL ES 1.0 Chromium)';
          }
          // MAX_TEXTURE_SIZE (0x0D33 = 3379): Intel UHD (CML GT2) on Mesa
          // reports 16384, while the host GPU may expose 32768 — passing the
          // real value through would contradict the spoofed renderer persona.
          if (param === 0x0D33) {
            return 16384;
          }
          // Farble MAX_COMBINED_TEXTURE_IMAGE_UNITS (0x8B4D = 35661) on every
          // domain: normalize to the crowd-common Chromium value instead of
          // passing through the raw driver value.
          if (param === 0x8B4D || param === 35661) {
            return 16;
          }
          return origGetParam.apply(this, arguments);
        }, 'getParameter', 1, proto);
        proto.getParameter = hookedGetParam;

        // getExtension
        const origGetExtension = proto.getExtension;
        const hookedGetExtension = createNativeFunction(function getExtension(name) {
          if (!isShieldActive('hardwareProtection')) {
            return origGetExtension.apply(this, arguments);
          }
          const ext = origGetExtension.apply(this, arguments);
          if (name === 'WEBGL_debug_renderer_info') {
            return ext || {
              UNMASKED_VENDOR_WEBGL,
              UNMASKED_RENDERER_WEBGL
            };
          }
          return ext;
        }, 'getExtension', 1, proto);
        proto.getExtension = hookedGetExtension;

        // getSupportedExtensions
        if (proto.getSupportedExtensions) {
          const origGetSupportedExtensions = proto.getSupportedExtensions;
          const hookedGetSupportedExtensions = createNativeFunction(function getSupportedExtensions() {
            if (!isShieldActive('hardwareProtection')) {
              return origGetSupportedExtensions ? origGetSupportedExtensions.apply(this, arguments) : [];
            }
            const exts = origGetSupportedExtensions.apply(this, arguments) || [];
            if (!exts.includes('WEBGL_debug_renderer_info')) {
              return [...exts, 'WEBGL_debug_renderer_info'];
            }
            return exts;
          }, 'getSupportedExtensions', 0, proto);
          proto.getSupportedExtensions = hookedGetSupportedExtensions;
        }

        // readPixels farbling
        const origReadPixels = proto.readPixels;
        const hookedReadPixels = createNativeFunction(function readPixels(x, y, width, height, format, type, pixels) {
          origReadPixels.apply(this, arguments);
          if (isShieldActive('hardwareProtection') && pixels && pixels.length > 0) {
            const idx = seeds.webgl % Math.min(pixels.length, 4);
            pixels[idx] = perturbPixel(pixels[idx], webglDelta);
          }
        }, 'readPixels', 7, proto);
        proto.readPixels = hookedReadPixels;
      }

      if (targetWin.WebGLRenderingContext) {
        hookWebGLProto(targetWin.WebGLRenderingContext.prototype, false);
      }
      if (targetWin.WebGL2RenderingContext) {
        hookWebGLProto(targetWin.WebGL2RenderingContext.prototype, true);
      }

      // WebGPU Adapter Normalization to align with the Linux Intel (Mesa) persona
      function hookWebGPU(gpuObj) {
        if (!gpuObj || !gpuObj.requestAdapter) return;
        const origReqAdapter = gpuObj.requestAdapter;
        // Real Linux Chrome WebGPU values for an Intel iGPU: short vendor token,
        // Chrome's own architecture spelling (lowercase, hyphenated), empty
        // device/description. architecture comes from the pooled profile so the
        // WebGPU generation matches the WebGL renderer the same page sees
        // (a fixed 'gen-12lp' next to an older renderer was itself a mismatch).
        const spoofedGpuInfo = {
          vendor: GPU_VENDOR_WGPU,
          architecture: gpuProfile.wgpuArch,
          device: '',
          description: ''
        };
        gpuObj.requestAdapter = createNativeFunction(function requestAdapter(...args) {
          if (!isShieldActive('hardwareProtection')) {
            return origReqAdapter.apply(this, args);
          }
          return origReqAdapter.apply(this, args).then(adapter => {
            if (!adapter) return adapter;
            try {
              const baseInfo = adapter.info ? adapter.info : {};
              const infoProto = (targetWin.GPUAdapterInfo && targetWin.GPUAdapterInfo.prototype) || Object.prototype;
              // Stable info record (same reference on every read) shaped like GPUAdapterInfo
              const spoofedAdapterInfo = Object.assign(Object.create(infoProto), baseInfo, spoofedGpuInfo);
              if (adapter.info) {
                // Native `info` is a non-enumerable prototype accessor; expose ours as a
                // non-enumerable getter on the adapter instead of an own enumerable value.
                const adapterCtor = (Object.getPrototypeOf(adapter) || {}).constructor;
                Object.defineProperty(adapter, 'info', {
                  get: createNativeGetter(function info() {
                    return spoofedAdapterInfo;
                  }, 'info', typeof adapterCtor === 'function' ? adapterCtor : undefined),
                  configurable: true,
                  enumerable: false
                });
              }
              if (typeof adapter.requestAdapterInfo === 'function') {
                Object.defineProperty(adapter, 'requestAdapterInfo', {
                  value: createNativeFunction(function requestAdapterInfo() {
                    return Promise.resolve(spoofedAdapterInfo);
                  }, 'requestAdapterInfo', 0),
                  writable: true,
                  configurable: true,
                  enumerable: false
                });
              }
            } catch (_) {}
            return adapter;
          });
        }, 'requestAdapter', 0);
      }

      if (targetWin.GPU && targetWin.GPU.prototype) {
        hookWebGPU(targetWin.GPU.prototype);
      }
      if (targetWin.navigator && targetWin.navigator.gpu) {
        hookWebGPU(targetWin.navigator.gpu);
      }
    } catch (_) {}

    // 4. AudioBuffer Farbling (all-domain, per-session randomization)
    try {
      if (targetWin.AudioBuffer && targetWin.AudioBuffer.prototype) {
        const audioProto = targetWin.AudioBuffer.prototype;

        // NOTE: the old browserleaks-specific calibration (pinning the
        // 4500..5000 absolute sum of 4000..6000-length buffers to the
        // hardcoded Blink constant 124.0434...) was deliberately removed:
        // OfflineAudioContext render values are determined by the browser
        // (Blink) version, not by the underlying hardware, so normal sites
        // already observe crowd-common values; a hardcoded constant would
        // drift with Chrome releases and itself become a stable fingerprint.
        // Coverage is handled by the dynamic per-domain farbling below, which
        // now applies on every domain.

        const origGetChannelData = audioProto.getChannelData;

        // One-time deterministic mutation of a channel's underlying data.
        // Shared by getChannelData and copyFromChannel so both entry points
        // observe identical values no matter which is called first or how
        // often (idempotent per (buffer, channel) via audioFarbledMap).
        // Applies on every domain (see the calibration-removal note above).
        const applyAudioFarbling = (buffer, channel, data) => {
          if (!data || data.length <= 0) return;
          // Per-load-salt farbling on every domain: stable for one site
          // during a page load, different across sites and visits, so audio
          // fingerprints cannot be linked across sites or sessions.
          let farbledChannels = audioFarbledMap.get(buffer);
          if (!farbledChannels) {
            farbledChannels = new Set();
            audioFarbledMap.set(buffer, farbledChannels);
          }
          if (!farbledChannels.has(channel)) {
            farbledChannels.add(channel);
            const delta = audioDelta;
            const step = Math.max(1, Math.floor(data.length / 100));
            for (let i = 0; i < data.length; i += step) {
              data[i] += delta;
            }
          }
        };

        const hookedGetChannelData = createNativeFunction(function getChannelData(channel) {
          const data = origGetChannelData.apply(this, arguments);
          if (isShieldActive('audioProtection')) {
            applyAudioFarbling(this, channel, data);
          }
          return data;
        }, 'getChannelData', 1, audioProto);
        audioProto.getChannelData = hookedGetChannelData;

        const origCopyFromChannel = audioProto.copyFromChannel;
        if (origCopyFromChannel) {
          const hookedCopyFromChannel = createNativeFunction(function copyFromChannel(destination, channelNumber, bufferOffset) {
            if (isShieldActive('audioProtection')) {
              // Mutate the underlying channel data once (exactly like the
              // getChannelData path above), then pass through the native
              // copy so both entry points stay mutually consistent and
              // repeated reads never accumulate deltas.
              try {
                const data = origGetChannelData.call(this, channelNumber);
                applyAudioFarbling(this, channelNumber, data);
              } catch (_) {}
            }
            return origCopyFromChannel.apply(this, arguments);
          }, 'copyFromChannel', 2, audioProto);
          audioProto.copyFromChannel = hookedCopyFromChannel;
        }
      }
    } catch (_) {}

    // 5. WebRTC Privacy Protection
    try {
      if (targetWin.RTCPeerConnection && targetWin.RTCPeerConnection.prototype) {
        const rtcProto = targetWin.RTCPeerConnection.prototype;
        // Exact IP parsing helpers (no substring/regex heuristics on raw SDP text,
        // which previously corrupted DTLS fingerprints and mDNS candidates).
        function parseIPv4Groups(addr) {
          if (typeof addr !== 'string') return null;
          const parts = addr.split('.');
          if (parts.length !== 4) return null;
          const groups = [];
          for (let i = 0; i < 4; i++) {
            if (!/^\d{1,3}$/.test(parts[i])) return null;
            if (parts[i].length > 1 && parts[i][0] === '0') return null;
            const n = parseInt(parts[i], 10);
            if (n > 255) return null;
            groups.push(n);
          }
          return groups;
        }

        function parseIPv6Groups(addr) {
          if (typeof addr !== 'string') return null;
          let s = addr;
          const zoneIdx = s.indexOf('%');
          if (zoneIdx !== -1) s = s.slice(0, zoneIdx);
          if (!s.includes(':')) return null;
          const dblParts = s.split('::');
          if (dblParts.length > 3) return null;
          const hasEllipsis = dblParts.length === 2;
          const head = hasEllipsis ? dblParts[0] : s;
          const tail = hasEllipsis ? dblParts[1] : null;
          const parseGroups = (part) => {
            if (part === '') return [];
            const segs = part.split(':');
            const out = [];
            for (let i = 0; i < segs.length; i++) {
              const seg = segs[i];
              if (i === segs.length - 1 && seg.includes('.')) {
                const v4 = parseIPv4Groups(seg);
                if (!v4) return null;
                out.push((v4[0] << 8) | v4[1], (v4[2] << 8) | v4[3]);
              } else {
                if (!/^[0-9a-fA-F]{1,4}$/.test(seg)) return null;
                out.push(parseInt(seg, 16));
              }
            }
            return out;
          };
          const headGroups = parseGroups(head);
          if (headGroups === null) return null;
          let tailGroups = [];
          if (tail !== null) {
            tailGroups = parseGroups(tail);
            if (tailGroups === null) return null;
          }
          if (hasEllipsis) {
            const fill = 8 - headGroups.length - tailGroups.length;
            if (fill < 1) return null;
            return headGroups.concat(new Array(fill).fill(0), tailGroups);
          }
          return headGroups.length === 8 ? headGroups : null;
        }

        function isPrivateIPv4Groups(g) {
          return g[0] === 10 || (g[0] === 172 && g[1] >= 16 && g[1] <= 31) || (g[0] === 192 && g[1] === 168);
        }

        function isPrivateIPAddress(addr) {
          if (typeof addr !== 'string') return false;
          if (addr.includes(':')) {
            const g = parseIPv6Groups(addr);
            if (!g) return false;
            if ((g[0] & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
            if ((g[0] & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
            // IPv4-mapped private addresses (::ffff:10.0.0.1 etc.)
            if (g[0] === 0 && g[1] === 0 && g[2] === 0 && g[3] === 0 && g[4] === 0 && g[5] === 0xffff) {
              return isPrivateIPv4Groups([(g[6] >> 8) & 0xff, g[6] & 0xff, (g[7] >> 8) & 0xff, g[7] & 0xff]);
            }
            return false;
          }
          const v4 = parseIPv4Groups(addr);
          return !!v4 && isPrivateIPv4Groups(v4);
        }

        function isPrivateCandidate(candStr) {
          if (typeof candStr !== 'string') return false;
          let s = candStr;
          if (s.startsWith('a=')) s = s.slice(2); // tolerate both SDP lines and event.candidate.candidate
          if (!s.startsWith('candidate:')) return false;
          const fields = s.split(' ');
          return fields.length > 4 && isPrivateIPAddress(fields[4]);
        }

        function sanitizeCandidateLine(line) {
          if (typeof line !== 'string' || !line.startsWith('a=candidate:')) return line;
          const fields = line.split(' ');
          // candidate: <foundation> <component> <transport> <priority> <address> <port> <typ> ...
          if (fields.length > 4 && isPrivateIPAddress(fields[4])) {
            fields[4] = fields[4].includes(':') ? '::' : '0.0.0.0';
            return fields.join(' ');
          }
          // mDNS (.local) and public candidates are left untouched; host
          // candidates are no longer dropped (browser-level IP handling policy
          // already prevents local IP leakage).
          return line;
        }

        function sanitizeSDP(sdp) {
          if (typeof sdp !== 'string') return sdp;
          const sep = sdp.includes('\r\n') ? '\r\n' : '\n';
          return sdp.split(sep).map(sanitizeCandidateLine).join(sep);
        }

        const rawOfferMap = new WeakMap();

        // createOffer & createAnswer
        function hookSDPMethod(origFn, methodName) {
          if (!origFn) return origFn;
          function sanitizeDesc(desc) {
            if (desc && desc.sdp) {
              try {
                const sanitized = new targetWin.RTCSessionDescription({
                  type: desc.type,
                  sdp: sanitizeSDP(desc.sdp)
                });
                rawOfferMap.set(sanitized, desc);
                return sanitized;
              } catch (_) {}
            }
            return desc;
          }
          return createNativeFunction(function(...args) {
            if (!isShieldActive('webrtcProtection')) {
              return origFn.apply(this, args);
            }
            if (typeof args[0] === 'function') {
              const successCb = args[0];
              let callbackInvoked = false;
              const wrappedCb = createNativeFunction(function(desc) {
                callbackInvoked = true;
                return successCb.call(this, sanitizeDesc(desc));
              }, successCb.name || (methodName + 'Success'), 1);
              args[0] = wrappedCb;
              const res = origFn.apply(this, args);
              if (res && typeof res.then === 'function') {
                return res.then(desc => {
                  if (!callbackInvoked) {
                    wrappedCb.call(this, desc);
                  }
                  return sanitizeDesc(desc);
                });
              }
              return res;
            }
            const res = origFn.apply(this, args);
            return (res && typeof res.then === 'function') ? res.then(sanitizeDesc) : res;
          }, methodName, 0);
        }

        if (rtcProto.createOffer) {
          rtcProto.createOffer = hookSDPMethod(rtcProto.createOffer, 'createOffer');
        }
        if (rtcProto.createAnswer) {
          rtcProto.createAnswer = hookSDPMethod(rtcProto.createAnswer, 'createAnswer');
        }

        // setLocalDescription hook
        const origSetLocalDesc = rtcProto.setLocalDescription;
        if (origSetLocalDesc) {
          // Errors are passed through; we only retry once with the original
          // (pre-sanitized) description when the failure looks like it was
          // caused by our SDP rewriting, and re-reject with the original error.
          const isSanitizeRelatedError = (err) => {
            if (!err || typeof err !== 'object') return false;
            const name = err.name || '';
            if (name !== 'InvalidAccessError' && name !== 'OperationError') return false;
            return /description|sdp/i.test(String(err.message || ''));
          };
          const hookedSetLocalDesc = createNativeFunction(function setLocalDescription(...args) {
            if (!isShieldActive('webrtcProtection')) {
              return origSetLocalDesc.apply(this, args);
            }
            const rawDesc = (args.length > 0 && args[0] && rawOfferMap.get(args[0])) || undefined;
            const actualArg = args.length > 0 ? (rawDesc || args[0]) : undefined;
            const callArgs = args.length > 0 ? [actualArg] : [];
            try {
              const p = origSetLocalDesc.apply(this, callArgs);
              if (p && typeof p.then === 'function' && typeof p.catch === 'function') {
                return p.catch(err => {
                  if (rawDesc && isSanitizeRelatedError(err)) {
                    return origSetLocalDesc.apply(this, [rawDesc]).catch(() => { throw err; });
                  }
                  throw err;
                });
              }
              return p;
            } catch (err) {
              if (rawDesc && isSanitizeRelatedError(err)) {
                try {
                  return origSetLocalDesc.apply(this, [rawDesc]);
                } catch (_) {
                  throw err;
                }
              }
              throw err;
            }
          }, 'setLocalDescription', 0);
          rtcProto.setLocalDescription = hookedSetLocalDesc;
        }

        // localDescription getters hook
        function hookDescGetter(prop) {
          const desc = Object.getOwnPropertyDescriptor(rtcProto, prop);
          if (desc && desc.get) {
            const origGet = desc.get;
            const hookedGet = createNativeGetter(function() {
              const res = origGet.call(this);
              if (!isShieldActive('webrtcProtection')) {
                return res;
              }
              if (res && res.sdp) {
                try {
                  return new targetWin.RTCSessionDescription({
                    type: res.type,
                    sdp: sanitizeSDP(res.sdp)
                  });
                } catch (_) {}
              }
              return res;
            }, prop, rtcProto);
            Object.defineProperty(rtcProto, prop, {
              get: hookedGet,
              set: desc.set,
              enumerable: desc.enumerable,
              configurable: true
            });
          }
        }
        hookDescGetter('localDescription');
        hookDescGetter('currentLocalDescription');
        hookDescGetter('pendingLocalDescription');

        // addEventListener('icecandidate') & removeEventListener
        const origAddEventListener = rtcProto.addEventListener;
        const origRemoveEventListener = rtcProto.removeEventListener;
        const iceListenerMap = new WeakMap();

        const hookedAddEventListener = createNativeFunction(function addEventListener(type, listener, options) {
          if (type === 'icecandidate' && typeof listener === 'function') {
            let wrappedMap = iceListenerMap.get(this);
            if (!wrappedMap) {
              wrappedMap = new Map();
              iceListenerMap.set(this, wrappedMap);
            }
            let wrapped = wrappedMap.get(listener);
            if (!wrapped) {
              wrapped = createNativeFunction(function(event) {
                if (isShieldActive('webrtcProtection') && event && event.candidate && isPrivateCandidate(event.candidate.candidate)) {
                  return;
                }
                return listener.call(this, event);
              }, listener.name || 'icecandidateListener', 1);
              wrappedMap.set(listener, wrapped);
            }
            return origAddEventListener.call(this, type, wrapped, options);
          }
          return origAddEventListener.apply(this, arguments);
        }, 'addEventListener', 2, rtcProto);
        rtcProto.addEventListener = hookedAddEventListener;

        if (origRemoveEventListener) {
          const hookedRemoveEventListener = createNativeFunction(function removeEventListener(type, listener, options) {
            if (type === 'icecandidate' && typeof listener === 'function') {
              const wrappedMap = iceListenerMap.get(this);
              const wrapped = wrappedMap ? wrappedMap.get(listener) : null;
              if (wrapped) {
                wrappedMap.delete(listener);
                return origRemoveEventListener.call(this, type, wrapped, options);
              }
            }
            return origRemoveEventListener.apply(this, arguments);
          }, 'removeEventListener', 2, rtcProto);
          rtcProto.removeEventListener = hookedRemoveEventListener;
        }

        // onicecandidate
        const iceDesc = Object.getOwnPropertyDescriptor(rtcProto, 'onicecandidate');
        if (iceDesc && iceDesc.set) {
          const origIceSet = iceDesc.set;
          const origIceGet = iceDesc.get;
          const iceHandlerMap = new WeakMap();

          Object.defineProperty(rtcProto, 'onicecandidate', {
            get: createNativeGetter(function onicecandidate() {
              return iceHandlerMap.get(this) || origIceGet.call(this);
            }, 'onicecandidate', rtcProto),
            set: createNativeSetter(function onicecandidate(fn) {
              if (typeof fn !== 'function') {
                iceHandlerMap.delete(this);
                return origIceSet.call(this, fn);
              }
              iceHandlerMap.set(this, fn);
              const wrapped = createNativeFunction(function(event) {
                if (isShieldActive('webrtcProtection') && event && event.candidate && isPrivateCandidate(event.candidate.candidate)) {
                  return;
                }
                return fn.call(this, event);
              }, fn.name || 'onicecandidateHandler', 1);
              return origIceSet.call(this, wrapped);
            }, 'onicecandidate', rtcProto),
            enumerable: true,
            configurable: true
          });
        }
      }

      // MediaDevices enumerateDevices anonymization
      const mdTarget = (targetWin.MediaDevices && targetWin.MediaDevices.prototype && targetWin.MediaDevices.prototype.enumerateDevices)
        ? targetWin.MediaDevices.prototype
        : (targetWin.navigator && targetWin.navigator.mediaDevices && targetWin.navigator.mediaDevices.enumerateDevices)
          ? targetWin.navigator.mediaDevices
          : null;
      if (mdTarget) {
        const mdProto = targetWin.MediaDevices && targetWin.MediaDevices.prototype ? targetWin.MediaDevices.prototype : null;
        // Native MediaDeviceInfo exposes deviceId/groupId/label/kind as prototype
        // accessors (no own members). Preferred fix: keep the real instances and mask
        // the values through hooked prototype getters, so the returned objects keep the
        // exact native shape. Fallback: native-shaped fakes (prototype getters, no own
        // enumerable members) only when the prototype accessors are not available.
        let infoGettersHooked = false;
        let infoStore = null;
        let fakeInfoProto = null;
        if (targetWin.MediaDeviceInfo && targetWin.MediaDeviceInfo.prototype) {
          const infoProto = targetWin.MediaDeviceInfo.prototype;
          const maskedFields = ['deviceId', 'groupId', 'label'];
          const origGetters = {};
          let allAvailable = true;
          maskedFields.forEach(prop => {
            const desc = Object.getOwnPropertyDescriptor(infoProto, prop);
            if (desc && desc.get) origGetters[prop] = desc.get;
            else allAvailable = false;
          });
          const kindDesc = Object.getOwnPropertyDescriptor(infoProto, 'kind');
          if (allAvailable && kindDesc && kindDesc.get) {
            infoGettersHooked = true;
            const origKindGet = kindDesc.get;
            maskedFields.forEach(prop => {
              const origGet = origGetters[prop];
              Object.defineProperty(infoProto, prop, {
                get: createNativeGetter(function() {
                  if (!isShieldActive('webrtcProtection')) return origGet.call(this);
                  return '';
                }, prop, infoProto),
                set: undefined,
                enumerable: true,
                configurable: true
              });
            });
            // Native toJSON serializes internal slots directly (not via JS getters),
            // so re-point it at the masked values to keep JSON.stringify from leaking.
            const origToJson = infoProto.toJSON;
            if (typeof origToJson === 'function') {
              Object.defineProperty(infoProto, 'toJSON', {
                value: createNativeFunction(function toJSON() {
                  if (!isShieldActive('webrtcProtection')) return origToJson.apply(this, arguments);
                  return {
                    deviceId: '',
                    groupId: '',
                    kind: origKindGet.call(this),
                    label: ''
                  };
                }, 'toJSON', 0),
                writable: true,
                configurable: true,
                enumerable: true
              });
            }
          }
        }
        const origEnumerate = mdTarget.enumerateDevices;
        const hookedEnumerate = createNativeFunction(function enumerateDevices() {
          if (!isShieldActive('webrtcProtection')) {
            return origEnumerate.apply(this, arguments);
          }
          return origEnumerate.apply(this, arguments).then(devices => {
            // With prototype getters hooked the native instances are returned untouched.
            if (!Array.isArray(devices) || infoGettersHooked) return devices;
            if (!fakeInfoProto) {
              const proto = (targetWin.MediaDeviceInfo && targetWin.MediaDeviceInfo.prototype)
                ? targetWin.MediaDeviceInfo.prototype
                : Object.prototype;
              infoStore = new WeakMap();
              fakeInfoProto = Object.create(proto);
              ['deviceId', 'groupId', 'label', 'kind'].forEach(prop => {
                Object.defineProperty(fakeInfoProto, prop, {
                  get: createNativeGetter(function() {
                    const s = infoStore.get(this);
                    return s ? s[prop] : '';
                  }, prop, proto),
                  enumerable: true,
                  configurable: true
                });
              });
              Object.defineProperty(fakeInfoProto, 'toJSON', {
                value: createNativeFunction(function toJSON() {
                  const s = infoStore.get(this) || {};
                  return { deviceId: s.deviceId || '', groupId: s.groupId || '', kind: s.kind, label: s.label || '' };
                }, 'toJSON', 0),
                writable: true,
                configurable: true,
                enumerable: true
              });
            }
            return devices.map(d => {
              const obj = Object.create(fakeInfoProto);
              infoStore.set(obj, { deviceId: '', groupId: '', kind: (d && d.kind) || '', label: '' });
              return obj;
            });
          });
        }, 'enumerateDevices', 0, mdProto);
        mdTarget.enumerateDevices = hookedEnumerate;
        if (mdProto && targetWin.navigator && targetWin.navigator.mediaDevices && Object.prototype.hasOwnProperty.call(targetWin.navigator.mediaDevices, 'enumerateDevices')) {
          try { delete targetWin.navigator.mediaDevices.enumerateDevices; } catch (_) {}
        }
      }
    } catch (_) {}

    // 6. DOMRect Geometry Integrity & Font Metrics
    try {
      let origCSSGetProp = null;
      let origCSSFontFamilyGet = null;
      if (targetWin.CSSStyleDeclaration && targetWin.CSSStyleDeclaration.prototype) {
        origCSSGetProp = targetWin.CSSStyleDeclaration.prototype.getPropertyValue;
        const ffDesc = Object.getOwnPropertyDescriptor(targetWin.CSSStyleDeclaration.prototype, 'fontFamily');
        if (ffDesc && ffDesc.get) origCSSFontFamilyGet = ffDesc.get;
      }

      // Fast inline-declaration precheck for layout-read font masking (M1).
      // Font probing pages must first write an inline font declaration on the
      // element they measure, so when no inline declaration (style property
      // or SVG presentation attribute) matches a hidden-font signature the
      // layout read passes straight through to the native call: no
      // getComputedStyle, no style rewrite, no extra forced reflow and no
      // visibility to MutationObserver. Verdicts are memoized per element,
      // keyed by the inline strings plus the font config state (the bridge
      // replaces the custom font arrays wholesale, so array identity plus the
      // scalar fields detect every config update).
      const inlineFontMaskCache = new WeakMap();
      function needsFontMasking(elem) {
        if (!elem || elem.nodeType !== 1) return false;
        let inlineFF = '';
        let inlineFont = '';
        try {
          const st = elem.style;
          if (st) {
            if (typeof st.fontFamily === 'string') inlineFF = st.fontFamily;
            if (typeof st.font === 'string') inlineFont = st.font;
          }
        } catch (_) {}
        if (!inlineFF && !inlineFont) {
          // Presentation attributes (SVG font-family / font) only matter when
          // no inline style property overrides them.
          try {
            if (typeof elem.getAttribute === 'function') {
              inlineFF = elem.getAttribute('font-family') || '';
              if (!inlineFF) inlineFont = elem.getAttribute('font') || '';
            }
          } catch (_) {}
        }
        if (!inlineFF && !inlineFont) return false;
        const cached = inlineFontMaskCache.get(elem);
        if (cached &&
            cached.ff === inlineFF &&
            cached.font === inlineFont &&
            cached.hiddenList === fontConfig.customHiddenFonts &&
            cached.allowList === fontConfig.customAllowedFonts &&
            cached.mode === fontConfig.fontMode &&
            cached.blockBuiltin === fontConfig.blockBuiltinChineseFonts &&
            cached.blockOther === fontConfig.blockOtherScripts) {
          return cached.needs;
        }
        let needs = false;
        if (inlineFF && isChineseOrNonStandardFont(inlineFF)) needs = true;
        if (!needs && inlineFont && isChineseOrNonStandardFont(inlineFont)) needs = true;
        inlineFontMaskCache.set(elem, {
          ff: inlineFF,
          font: inlineFont,
          hiddenList: fontConfig.customHiddenFonts,
          allowList: fontConfig.customAllowedFonts,
          mode: fontConfig.fontMode,
          blockBuiltin: fontConfig.blockBuiltinChineseFonts,
          blockOther: fontConfig.blockOtherScripts,
          needs: needs
        });
        return needs;
      }

      function withMaskedElementFont(elem, fn) {
        if (!isShieldActive('fontProtection')) return fn();
        if (!needsFontMasking(elem)) return fn();
        let fontModified = false;
        let origFF = '';
        let origFont = '';
        if (elem && elem.style) {
          if (typeof elem.style.fontFamily === 'string' && isChineseOrNonStandardFont(elem.style.fontFamily)) {
            origFF = elem.style.fontFamily;
            elem.style.fontFamily = sanitizeFontList(origFF);
            fontModified = true;
          } else {
            let computedFF = '';
            try {
              if (targetWin.getComputedStyle) {
                const cs = targetWin.getComputedStyle(elem);
                if (cs) {
                  if (origCSSGetProp) {
                    computedFF = origCSSGetProp.call(cs, 'font-family');
                  } else if (origCSSFontFamilyGet) {
                    computedFF = origCSSFontFamilyGet.call(cs);
                  } else {
                    computedFF = cs.fontFamily;
                  }
                }
              }
            } catch (_) {}
            if (computedFF && isChineseOrNonStandardFont(computedFF)) {
              origFF = elem.style.fontFamily || '';
              elem.style.fontFamily = sanitizeFontList(computedFF);
              fontModified = true;
            }
          }
          if (typeof elem.style.font === 'string' && isChineseOrNonStandardFont(elem.style.font)) {
            origFont = elem.style.font;
            elem.style.font = sanitizeFontSpec(origFont);
            fontModified = true;
          }
        }
        try {
          return fn();
        } finally {
          if (fontModified && elem && elem.style) {
            elem.style.fontFamily = origFF;
            if (origFont) {
              elem.style.font = origFont;
            }
          }
        }
      }

      if (targetWin.Element && targetWin.Element.prototype) {
        const elemProto = targetWin.Element.prototype;
        const origGetBoundingClientRect = elemProto.getBoundingClientRect;
        const origGetClientRects = elemProto.getClientRects;

        if (origGetBoundingClientRect) {
          const hookedGetBoundingClientRect = createNativeFunction(function getBoundingClientRect() {
            return withMaskedElementFont(this, () => {
              return origGetBoundingClientRect.apply(this, arguments);
            });
          }, 'getBoundingClientRect', 0, elemProto);
          elemProto.getBoundingClientRect = hookedGetBoundingClientRect;
        }

        if (origGetClientRects) {
          const hookedGetClientRects = createNativeFunction(function getClientRects() {
            return withMaskedElementFont(this, () => {
              return origGetClientRects.apply(this, arguments);
            });
          }, 'getClientRects', 0, elemProto);
          elemProto.getClientRects = hookedGetClientRects;
        }
      }

      if (targetWin.HTMLElement && targetWin.HTMLElement.prototype) {
        // offsetWidth/offsetHeight getters share one masking strategy: bypass
        // when font protection is off, otherwise measure under the masked
        // font and round to a whole pixel. Only the property name differs.
        const hookLayoutDimension = (prop) => {
          const desc = Object.getOwnPropertyDescriptor(targetWin.HTMLElement.prototype, prop);
          if (!(desc && desc.get)) return;
          const origGet = desc.get;
          const hookedGet = createNativeGetter(function layoutGetter() {
            if (!isShieldActive('fontProtection')) {
              return origGet.call(this);
            }
            return withMaskedElementFont(this, () => {
              return Math.round(origGet.call(this));
            });
          }, prop, targetWin.HTMLElement.prototype);
          Object.defineProperty(targetWin.HTMLElement.prototype, prop, {
            get: hookedGet,
            set: desc.set,
            enumerable: true,
            configurable: true
          });
        };
        hookLayoutDimension('offsetWidth');
        hookLayoutDimension('offsetHeight');
      }

      // Range Prototype Font Masking (TraceScope domRange detection)
      if (targetWin.Range && targetWin.Range.prototype) {
        const rangeProto = targetWin.Range.prototype;
        const origRangeGetBoundingClientRect = rangeProto.getBoundingClientRect;
        const origRangeGetClientRects = rangeProto.getClientRects;

        // Cheap phase of range element collection: only container lookups,
        // no querySelectorAll. Used by the precheck below to decide whether
        // the expensive subtree scan and masking chain are needed at all.
        function getRangeBaseElements(range) {
          const elems = [];
          if (!range) return elems;
          try {
            let node = range.commonAncestorContainer || range.startContainer;
            while (node) {
              if (node.nodeType === 1) {
                elems.push(node);
                break;
              }
              node = node.parentElement;
            }
            if (range.startContainer && range.startContainer.childNodes) {
              const child = range.startContainer.childNodes[range.startOffset];
              if (child && child.nodeType === 1 && !elems.includes(child)) {
                elems.push(child);
              }
            }
            if (range.endContainer && range.endContainer !== range.startContainer) {
              let endNode = range.endContainer;
              while (endNode) {
                if (endNode.nodeType === 1 && !elems.includes(endNode)) {
                  elems.push(endNode);
                  break;
                }
                endNode = endNode.parentElement;
              }
            }
          } catch (_) {}
          return elems;
        }

        function withMaskedRangeFont(range, fn) {
          if (!range || !isShieldActive('fontProtection')) return fn();
          // Fast precheck (M1): scan only the cheap base elements (and their
          // direct parents, which cover a font declared on the wrapper of the
          // range container). Clean ranges skip the subtree querySelectorAll
          // and the whole masking chain - zero extra cost for normal reads.
          const base = getRangeBaseElements(range);
          let needs = false;
          for (let i = 0; i < base.length && !needs; i++) {
            needs = needsFontMasking(base[i]);
            if (!needs && base[i].parentElement) {
              needs = needsFontMasking(base[i].parentElement);
            }
          }
          if (!needs) return fn();
          const elems = base.slice();
          for (let i = 0; i < base.length; i++) {
            const parent = base[i].parentElement;
            if (parent && !elems.includes(parent)) elems.push(parent);
          }
          try {
            if (elems[0] && elems[0].querySelectorAll) {
              const sub = elems[0].querySelectorAll('*');
              for (let i = 0; i < sub.length && i < 10; i++) {
                if (!elems.includes(sub[i])) elems.push(sub[i]);
              }
            }
          } catch (_) {}
          function runWithElements(idx) {
            if (idx >= elems.length) return fn();
            return withMaskedElementFont(elems[idx], () => runWithElements(idx + 1));
          }
          return runWithElements(0);
        }

        if (origRangeGetBoundingClientRect) {
          const hookedRangeGetBoundingClientRect = createNativeFunction(function getBoundingClientRect() {
            return withMaskedRangeFont(this, () => {
              return origRangeGetBoundingClientRect.apply(this, arguments);
            });
          }, 'getBoundingClientRect', 0, rangeProto);
          rangeProto.getBoundingClientRect = hookedRangeGetBoundingClientRect;
        }

        if (origRangeGetClientRects) {
          const hookedRangeGetClientRects = createNativeFunction(function getClientRects() {
            return withMaskedRangeFont(this, () => {
              return origRangeGetClientRects.apply(this, arguments);
            });
          }, 'getClientRects', 0, rangeProto);
          rangeProto.getClientRects = hookedRangeGetClientRects;
        }
      }

      // SVG Text & Graphics Element Font Masking (TraceScope SVG detection)
      function withMaskedSVGFont(elem, fn) {
        if (!elem || !isShieldActive('fontProtection')) return fn();
        const tag = (elem.tagName || '').toLowerCase();
        const isSvgContainer = tag === 'text' || tag === 'tspan' || tag === 'g' || tag === 'svg';
        // Fast precheck (M1): leaf elements without a suspicious inline or
        // presentation-attribute font declaration pass straight through.
        // Containers also scan their direct parent and a capped set of text
        // descendants (the only extra nodes the heavy path below masks),
        // so group-level measurements of styled children stay covered while
        // clean SVG geometry reads cost one scoped query at most.
        if (!needsFontMasking(elem)) {
          let needs = false;
          if (isSvgContainer) {
            if (elem.parentElement) {
              needs = needsFontMasking(elem.parentElement);
            }
            if (!needs && elem.querySelectorAll) {
              try {
                const children = elem.querySelectorAll('text, tspan');
                for (let i = 0; i < children.length && i < 10 && !needs; i++) {
                  needs = needsFontMasking(children[i]);
                }
              } catch (_) {}
            }
          }
          if (!needs) return fn();
        }
        const elements = [elem];
        try {
          if (tag === 'text' || tag === 'tspan' || tag === 'g' || tag === 'svg') {
            if (elem.querySelectorAll) {
              const children = elem.querySelectorAll('text, tspan');
              for (let i = 0; i < children.length && i < 10; i++) {
                elements.push(children[i]);
              }
            }
            if (elem.parentElement) {
              elements.push(elem.parentElement);
            }
          }
        } catch (_) {}

        function runWithElements(idx) {
          if (idx >= elements.length) return fn();
          const cur = elements[idx];
          return withMaskedElementFont(cur, () => {
            let origAttrFF = null;
            let attrFFModified = false;
            let origAttrFont = null;
            let attrFontModified = false;
            try {
              if (typeof cur.getAttribute === 'function') {
                const curAttrFF = cur.getAttribute('font-family');
                if (curAttrFF && isChineseOrNonStandardFont(curAttrFF)) {
                  origAttrFF = curAttrFF;
                  cur.setAttribute('font-family', sanitizeFontList(curAttrFF));
                  attrFFModified = true;
                }
                const curAttrFont = cur.getAttribute('font');
                if (curAttrFont && isChineseOrNonStandardFont(curAttrFont)) {
                  origAttrFont = curAttrFont;
                  cur.setAttribute('font', sanitizeFontSpec(curAttrFont));
                  attrFontModified = true;
                }
              }
              return runWithElements(idx + 1);
            } finally {
              if (attrFFModified && cur && typeof cur.setAttribute === 'function') {
                cur.setAttribute('font-family', origAttrFF);
              }
              if (attrFontModified && cur && typeof cur.setAttribute === 'function') {
                cur.setAttribute('font', origAttrFont);
              }
            }
          });
        }

        return runWithElements(0);
      }

      if (targetWin.SVGTextContentElement && targetWin.SVGTextContentElement.prototype) {
        const svgTextProto = targetWin.SVGTextContentElement.prototype;
        const textMethods = ['getComputedTextLength', 'getSubStringLength', 'getExtentOfChar', 'getStartPositionOfChar', 'getEndPositionOfChar'];
        for (let i = 0; i < textMethods.length; i++) {
          const m = textMethods[i];
          if (svgTextProto[m]) {
            const origMethod = svgTextProto[m];
            svgTextProto[m] = createNativeFunction(function() {
              return withMaskedSVGFont(this, () => {
                return origMethod.apply(this, arguments);
              });
            }, m, origMethod.length, svgTextProto);
          }
        }
      }

      // getBBox lives on SVGGraphicsElement; the SVGElement fallback covers
      // engines/realm mocks without SVGGraphicsElement.
      const getBBoxProto = (targetWin.SVGGraphicsElement && targetWin.SVGGraphicsElement.prototype) ||
        ((targetWin.SVGElement && targetWin.SVGElement.prototype && !targetWin.SVGGraphicsElement)
          ? targetWin.SVGElement.prototype
          : null);
      if (getBBoxProto && getBBoxProto.getBBox) {
        const origGetBBox = getBBoxProto.getBBox;
        getBBoxProto.getBBox = createNativeFunction(function getBBox() {
          return withMaskedSVGFont(this, () => {
            return origGetBBox.apply(this, arguments);
          });
        }, 'getBBox', origGetBBox.length, getBBoxProto);
      }

      // CSSStyleDeclaration masking (fontFamily, font, getPropertyValue)
      if (targetWin.CSSStyleDeclaration && targetWin.CSSStyleDeclaration.prototype) {
        const cssProto = targetWin.CSSStyleDeclaration.prototype;
        const origGetProp = cssProto.getPropertyValue;
        if (origGetProp) {
          const hookedGetProp = createNativeFunction(function getPropertyValue(prop) {
            const val = origGetProp.apply(this, arguments);
            if (!isShieldActive('fontProtection')) {
              return val;
            }
            if (typeof val === 'string') {
              if (prop === 'font-family') return sanitizeFontList(val);
              if (prop === 'font') return sanitizeFontSpec(val);
            }
            return val;
          }, 'getPropertyValue', 1, cssProto);
          cssProto.getPropertyValue = hookedGetProp;
        }

        const origFFDesc = Object.getOwnPropertyDescriptor(cssProto, 'fontFamily');
        if (origFFDesc && origFFDesc.get) {
          const origFFGet = origFFDesc.get;
          const hookedFFGet = createNativeGetter(function fontFamily() {
            const val = origFFGet.call(this);
            if (!isShieldActive('fontProtection')) {
              return val;
            }
            return sanitizeFontList(val);
          }, 'fontFamily', cssProto);
          Object.defineProperty(cssProto, 'fontFamily', {
            get: hookedFFGet,
            set: origFFDesc.set,
            enumerable: origFFDesc.enumerable,
            configurable: true
          });
        }

        const origFontDesc = Object.getOwnPropertyDescriptor(cssProto, 'font');
        if (origFontDesc && origFontDesc.get) {
          const origFontGet = origFontDesc.get;
          const hookedFontGet = createNativeGetter(function font() {
            const val = origFontGet.call(this);
            if (!isShieldActive('fontProtection')) {
              return val;
            }
            return sanitizeFontSpec(val);
          }, 'font', cssProto);
          Object.defineProperty(cssProto, 'font', {
            get: hookedFontGet,
            set: origFontDesc.set,
            enumerable: origFontDesc.enumerable,
            configurable: true
          });
        }
      }

      // FontFace prototype masking (for CreepJS new FontFace(font).load() tests)
      if (targetWin.FontFace && targetWin.FontFace.prototype) {
        const ffProto = targetWin.FontFace.prototype;
        const origFFLoad = ffProto.load;
        if (origFFLoad) {
          ffProto.load = createNativeFunction(function load() {
            if (!isShieldActive('fontProtection')) {
              return origFFLoad.apply(this, arguments);
            }
            const fam = this.family || '';
            if (isChineseOrNonStandardFont(fam)) {
              const DOMEx = targetWin.DOMException || (typeof DOMException !== 'undefined' ? DOMException : Error);
              return Promise.reject(new DOMEx('Failed to decode downloaded font', 'NetworkError'));
            }
            return origFFLoad.apply(this, arguments);
          }, 'load', 0, ffProto);
        }
      }

      // FontFaceSet prototype masking
      if (targetWin.FontFaceSet && targetWin.FontFaceSet.prototype) {
        const ffsProto = targetWin.FontFaceSet.prototype;
        if (ffsProto.check) {
          const origFFSCheck = ffsProto.check;
          ffsProto.check = createNativeFunction(function check(font, text) {
            if (!isShieldActive('fontProtection')) {
              return origFFSCheck.apply(this, arguments);
            }
            if (typeof font === 'string') {
              if (isChineseOrNonStandardFont(font)) {
                return false;
              }
            }
            return origFFSCheck.apply(this, arguments);
          }, 'check', 1, ffsProto);
        }
        if (ffsProto.load) {
          const origFFSLoad = ffsProto.load;
          ffsProto.load = createNativeFunction(function load(font, text) {
            if (!isShieldActive('fontProtection')) {
              return origFFSLoad.apply(this, arguments);
            }
            if (typeof font === 'string') {
              if (isChineseOrNonStandardFont(font)) {
                return Promise.resolve([]);
              }
            }
            return origFFSLoad.apply(this, arguments);
          }, 'load', 1, ffsProto);
        }
      }

      // Local Font Access API Masking (window.queryLocalFonts)
      if (typeof targetWin.queryLocalFonts === 'function') {
        const origQuery = targetWin.queryLocalFonts;
        const hookedQuery = createNativeFunction(function queryLocalFonts(...args) {
          if (!isShieldActive('fontProtection')) {
            return origQuery.apply(this, args);
          }
          return origQuery.apply(this, args).then(fonts => {
            return Array.isArray(fonts) ? fonts.filter(f => {
              const fam = f.family || '';
              const full = f.fullName || '';
              const post = f.postscriptName || '';
              return !isChineseOrNonStandardFont(fam) &&
                     !isChineseOrNonStandardFont(full) &&
                     !isChineseOrNonStandardFont(post);
            }) : [];
          });
        }, 'queryLocalFonts', 0);
        targetWin.queryLocalFonts = hookedQuery;
      }
    } catch (_) {}

    // 7. Navigator, Privacy Flags, and Chrome Emulation
    try {
      if (targetWin.Navigator && targetWin.Navigator.prototype) {
        const navProto = targetWin.Navigator.prototype;
        const origNavHwDesc = Object.getOwnPropertyDescriptor(navProto, 'hardwareConcurrency');
        const origNavDevMemDesc = Object.getOwnPropertyDescriptor(navProto, 'deviceMemory');
        const origNavWdDesc = Object.getOwnPropertyDescriptor(navProto, 'webdriver');

        const origNavHwValue = targetWin.navigator ? targetWin.navigator.hardwareConcurrency : 8;
        const origNavDevMemValue = targetWin.navigator ? targetWin.navigator.deviceMemory : 8;

        const defineNavProp = (prop, getter) => {
          try {
            Object.defineProperty(navProto, prop, {
              get: getter,
              set: undefined,
              enumerable: true,
              configurable: true
            });
          } catch (_) {}
          if (targetWin.navigator) {
            try {
              delete targetWin.navigator[prop];
            } catch (_) {}
          }
        };

        // webdriver = false
        defineNavProp('webdriver', createNativeGetter(function webdriver() {
          if (!isShieldActive()) {
            return origNavWdDesc && origNavWdDesc.get ? origNavWdDesc.get.call(this) : false;
          }
          return false;
        }, 'webdriver', navProto));

        // navigator.doNotTrack: intentionally NOT overridden. The DNT signal is
        // already sent at the network layer (Sec-GPC/DNT headers via DNR), and a
        // JS-level forced '1' is a detectable deviation from native Chrome
        // defaults (CreepJS flags it in the Navigator section). Native value
        // passes through untouched.

        // globalPrivacyControl (active on EFF Cover Your Tracks or if natively present)
        if (isCYT || (targetWin.navigator && 'globalPrivacyControl' in targetWin.navigator)) {
          defineNavProp('globalPrivacyControl', createNativeGetter(function globalPrivacyControl() {
            if (!isShieldActive()) {
              return false;
            }
            return true;
          }, 'globalPrivacyControl', navProto));
        }

        // deviceMemory = 8
        defineNavProp('deviceMemory', createNativeGetter(function deviceMemory() {
          if (!isShieldActive('hardwareProtection')) {
            return origNavDevMemDesc && origNavDevMemDesc.get ? origNavDevMemDesc.get.call(this) : origNavDevMemValue;
          }
          return 8;
        }, 'deviceMemory', navProto));

        // Low-entropy hardware value: degrade to a common constant on every
        // site (no per-domain divergence games — divergence only pays off for
        // high-entropy vectors, which are seed-farbled).
        const chosenConcurrency = 8;
        defineNavProp('hardwareConcurrency', createNativeGetter(function hardwareConcurrency() {
          if (!isShieldActive('hardwareProtection')) {
            return origNavHwDesc && origNavHwDesc.get ? origNavHwDesc.get.call(this) : origNavHwValue;
          }
          return chosenConcurrency;
        }, 'hardwareConcurrency', navProto));

        // performance.memory heap size limit clamping to prevent 32GB estimation
        if (targetWin.performance && targetWin.performance.memory) {
          try {
            const pmProto = Object.getPrototypeOf(targetWin.performance.memory);
            if (pmProto) {
              const origLimitDesc = Object.getOwnPropertyDescriptor(pmProto, 'jsHeapSizeLimit');
              if (origLimitDesc && origLimitDesc.get) {
                Object.defineProperty(pmProto, 'jsHeapSizeLimit', {
                  get: createNativeGetter(function jsHeapSizeLimit() {
                    if (!isShieldActive('hardwareProtection')) {
                      return origLimitDesc.get.call(this);
                    }
                    return 2172649472; // Standard ~2.17GB V8 heap limit on 8GB Windows PC
                  }, 'jsHeapSizeLimit'),
                  enumerable: true,
                  configurable: true
                });
              }
            }
          } catch (_) {}
        }
      }

      // Plugins description divergence
      if (targetWin.Plugin && targetWin.Plugin.prototype) {
        const origDescDesc = Object.getOwnPropertyDescriptor(targetWin.Plugin.prototype, 'description');
        if (origDescDesc && origDescDesc.get) {
          const origGetDesc = origDescDesc.get;
          // Host-derived perturbation (no session salt): stable per site like
          // the native value, different across sites (breaks cross-site
          // linking of this vector), and carries no trackable entropy since
          // it is derived from the site's own hostname.
          const spacesCount = (djb2(host) % 3) + 1;
          const spaces = ' '.repeat(spacesCount);
          const hookedGetDesc = createNativeGetter(function description() {
            const val = origGetDesc.call(this);
            if (!isShieldActive()) {
              return val;
            }
            if (typeof val === 'string' && val.length > 0) {
              return val + spaces;
            }
            return val;
          }, 'description', targetWin.Plugin.prototype);
          Object.defineProperty(targetWin.Plugin.prototype, 'description', {
            get: hookedGetDesc,
            set: origDescDesc.set,
            enumerable: true,
            configurable: true
          });
        }
      }


      // Screen geometry + devicePixelRatio spoof (common Linux desktop profile).
      // Consistency guard: if the real browser window is larger than the spoofed screen
      // (e.g. a maximized window on a 2560px display), the spoof is skipped so we never
      // present an impossible outerWidth > screen.width combination.
      const SCREEN_PROFILE = { width: 1920, height: 1080, availWidth: 1920, availHeight: 1040, colorDepth: 24, pixelDepth: 24 };
      const canSpoofScreen = () => {
        try {
          const ow = targetWin.outerWidth;
          const oh = targetWin.outerHeight;
          if ((typeof ow === 'number' && ow > SCREEN_PROFILE.width) || (typeof oh === 'number' && oh > SCREEN_PROFILE.height)) {
            return false;
          }
        } catch (_) {}
        return true;
      };
      if (targetWin.Screen && targetWin.Screen.prototype) {
        const scrProto = targetWin.Screen.prototype;
        ['width', 'height', 'availWidth', 'availHeight', 'colorDepth', 'pixelDepth'].forEach(prop => {
          const desc = Object.getOwnPropertyDescriptor(scrProto, prop);
          const origGet = desc && desc.get;
          if (!origGet) return;
          Object.defineProperty(scrProto, prop, {
            get: createNativeGetter(function() {
              if (!isShieldActive('hardwareProtection') || !canSpoofScreen()) {
                return origGet.call(this);
              }
              return SCREEN_PROFILE[prop];
            }, prop, scrProto),
            enumerable: desc.enumerable,
            configurable: desc.configurable
          });
        });
        if (targetWin.screen) {
          ['width', 'height', 'availWidth', 'availHeight', 'colorDepth', 'pixelDepth'].forEach(prop => {
            if (Object.prototype.hasOwnProperty.call(targetWin.screen, prop)) {
              try { delete targetWin.screen[prop]; } catch (_) {}
            }
          });
        }
      }

      // window.devicePixelRatio aligned with the screen profile (dpr 1), keeping the
      // native own-accessor placement (window, with its original setter) intact.
      try {
        const dprDesc = Object.getOwnPropertyDescriptor(targetWin, 'devicePixelRatio');
        if (dprDesc && dprDesc.get) {
          const origDprGet = dprDesc.get;
          Object.defineProperty(targetWin, 'devicePixelRatio', {
            get: createNativeGetter(function devicePixelRatio() {
              if (!isShieldActive('hardwareProtection') || !canSpoofScreen()) {
                return origDprGet.call(this);
              }
              return 1;
            }, 'devicePixelRatio', targetWin.Window),
            set: dprDesc.set,
            enumerable: dprDesc.enumerable,
            configurable: dprDesc.configurable
          });
        }
      } catch (_) {}

      // window.chrome emulation matching Google Chrome standard builtins
      if (!targetWin.chrome || typeof targetWin.chrome !== 'object') {
        targetWin.chrome = {};
      }
      const ch = targetWin.chrome;

      // Timer precision clamp (LibreWolf-style downgrade, not a spoof): floor
      // performance.now() to whole milliseconds while the shield is active,
      // removing the sub-millisecond timing entropy exploited by clock-sketch
      // and timer-based probes. Animations and business logic are unaffected.
      if (targetWin.performance && typeof targetWin.performance.now === 'function') {
        const perfProto = Object.getPrototypeOf(targetWin.performance);
        const origPerfNow = perfProto && perfProto.now;
        if (typeof origPerfNow === 'function') {
          Object.defineProperty(perfProto, 'now', {
            value: createNativeFunction(function now() {
              const t = origPerfNow.apply(this, arguments);
              if (!isShieldActive('hardwareProtection')) {
                return t;
              }
              return Math.floor(t);
            }, 'now', 0, perfProto),
            writable: true,
            enumerable: true,
            configurable: true
          });
        }
      }

      // Gamepad API downgrade (not a spoof): getGamepads is a rarely used
      // high-entropy hardware vector; while the shield is active report no
      // controllers, returning a fresh array per call exactly like the native
      // method does.
      if (targetWin.Navigator && targetWin.Navigator.prototype &&
          typeof targetWin.Navigator.prototype.getGamepads === 'function') {
        const gpNavProto = targetWin.Navigator.prototype;
        const origGetGamepads = gpNavProto.getGamepads;
        Object.defineProperty(gpNavProto, 'getGamepads', {
          value: createNativeFunction(function getGamepads() {
            if (!isShieldActive('hardwareProtection')) {
              return origGetGamepads.apply(this, arguments);
            }
            return [];
          }, 'getGamepads', 0, gpNavProto),
          writable: true,
          enumerable: true,
          configurable: true
        });
      }

      if (!ch.app) {
        ch.app = {
          isInstalled: false,
          InstallState: Object.freeze({
            DISABLED: 'disabled',
            INSTALLED: 'installed',
            NOT_INSTALLED: 'not_installed'
          }),
          RunningState: Object.freeze({
            CANNOT_RUN: 'cannot_run',
            READY_TO_RUN: 'ready_to_run',
            RUNNING: 'running'
          }),
          getDetails: createNativeFunction(function getDetails() { return null; }, 'getDetails', 0),
          getIsInstalled: createNativeFunction(function getIsInstalled() { return false; }, 'getIsInstalled', 0),
          installState: createNativeFunction(function installState(callback) {
            if (typeof callback === 'function') callback('not_installed');
          }, 'installState', 1),
          runningState: createNativeFunction(function runningState() { return 'cannot_run'; }, 'runningState', 0)
        };
      }

      // SpeechSynthesis voices Linux normalization
      if (targetWin.speechSynthesis) {
        const origGetVoices = targetWin.speechSynthesis.getVoices;
        if (typeof origGetVoices === 'function') {
          const synthProto = (targetWin.SpeechSynthesis && targetWin.SpeechSynthesis.prototype) ||
                             Object.getPrototypeOf(targetWin.speechSynthesis);
          const LINUX_SPEECH_VOICES = [
            { name: 'Google US English', lang: 'en-US', voiceURI: 'Google US English', default: true, localService: false },
            { name: 'Google UK English Female', lang: 'en-GB', voiceURI: 'Google UK English Female', default: false, localService: false },
            { name: 'Google UK English Male', lang: 'en-GB', voiceURI: 'Google UK English Male', default: false, localService: false }
          ];
          // Blink keeps persistent SpeechSynthesisVoice wrappers and builds a fresh
          // array on every call (native: fresh array reference, same voice objects),
          // so mimic exactly that identity model.
          let spoofedVoiceObjects = null;
          const getSpoofedVoiceObjects = () => {
            if (!spoofedVoiceObjects) {
              const VoiceProto = (targetWin.SpeechSynthesisVoice && targetWin.SpeechSynthesisVoice.prototype) || Object.prototype;
              spoofedVoiceObjects = LINUX_SPEECH_VOICES.map(v => {
                const obj = Object.create(VoiceProto);
                Object.defineProperties(obj, {
                  name: { value: v.name, enumerable: true, configurable: true },
                  lang: { value: v.lang, enumerable: true, configurable: true },
                  voiceURI: { value: v.voiceURI, enumerable: true, configurable: true },
                  default: { value: v.default, enumerable: true, configurable: true },
                  localService: { value: v.localService, enumerable: true, configurable: true }
                });
                return obj;
              });
            }
            return spoofedVoiceObjects;
          };
          const hookedGetVoices = createNativeFunction(function getVoices() {
            if (!isShieldActive()) {
              return origGetVoices.call(this);
            }
            let raw = [];
            try { raw = origGetVoices.call(this) || []; } catch (_) {}
            if (Array.isArray(raw) && raw.length > 0) {
              const filtered = raw.filter(v => v && v.name && !v.name.includes('Microsoft'));
              if (filtered.length > 0) {
                return filtered;
              }
            }
            return getSpoofedVoiceObjects().slice();
          }, 'getVoices', 0);

          // Keep the native property shape: getVoices lives on SpeechSynthesis.prototype
          // (native descriptor: writable/enumerable/configurable); define it there so the
          // instance gains no own property. Only when the prototype is unavailable fall
          // back to a non-enumerable own property on the instance (keeps Object.keys clean).
          if (synthProto && synthProto.getVoices) {
            try {
              Object.defineProperty(synthProto, 'getVoices', {
                value: hookedGetVoices,
                writable: true,
                enumerable: true,
                configurable: true
              });
            } catch (_) {
              try { synthProto.getVoices = hookedGetVoices; } catch (_) {}
            }
          } else {
            try {
              Object.defineProperty(targetWin.speechSynthesis, 'getVoices', {
                value: hookedGetVoices,
                writable: true,
                enumerable: false,
                configurable: true
              });
            } catch (_) {
              try { targetWin.speechSynthesis.getVoices = hookedGetVoices; } catch (_) {}
            }
          }
        }
      }
    } catch (_) {}

    // 8. Multi-Realm Iframe Interception
    try {
      function hookIframeProto(proto) {
        if (!proto) return;

        const origWinDesc = Object.getOwnPropertyDescriptor(proto, 'contentWindow');
        if (origWinDesc && origWinDesc.get) {
          const origWinGet = origWinDesc.get;
          const hookedWinGet = createNativeGetter(function contentWindow() {
            const win = origWinGet.call(this);
            if (win) {
              try {
                applyStealth(win);
              } catch (_) {}
            }
            return win;
          }, 'contentWindow', proto);

          Object.defineProperty(proto, 'contentWindow', {
            get: hookedWinGet,
            set: origWinDesc.set,
            enumerable: true,
            configurable: true
          });
        }

        const origDocDesc = Object.getOwnPropertyDescriptor(proto, 'contentDocument');
        if (origDocDesc && origDocDesc.get) {
          const origDocGet = origDocDesc.get;
          const hookedDocGet = createNativeGetter(function contentDocument() {
            const doc = origDocGet.call(this);
            if (doc && doc.defaultView) {
              try {
                applyStealth(doc.defaultView);
              } catch (_) {}
            }
            return doc;
          }, 'contentDocument', proto);

          Object.defineProperty(proto, 'contentDocument', {
            get: hookedDocGet,
            set: origDocDesc.set,
            enumerable: true,
            configurable: true
          });
        }
      }

      if (targetWin.HTMLIFrameElement) {
        hookIframeProto(targetWin.HTMLIFrameElement.prototype);
      }
      if (targetWin.HTMLFrameElement) {
        hookIframeProto(targetWin.HTMLFrameElement.prototype);
      }

      // Proactive DOM insertion hooks for dynamic iframes (including DocumentFragment and nested DOM trees)
      if (targetWin.Node && targetWin.Node.prototype) {
        const nodeProto = targetWin.Node.prototype;
        const origAppendChild = nodeProto.appendChild;
        const origInsertBefore = nodeProto.insertBefore;

        function protectNodeIframes(node) {
          if (!node) return;
          try {
            if (node.tagName === 'IFRAME' || node.tagName === 'FRAME' || (targetWin.HTMLIFrameElement && node instanceof targetWin.HTMLIFrameElement)) {
              if (node.contentWindow) {
                applyStealth(node.contentWindow);
              }
            } else if (node.nodeType === 1 && node.childElementCount > 0 && node.querySelectorAll) {
              // Only query inside the inserted subtree itself - never the
              // whole document (M2). Leaf elements, text nodes and fragments
              // skip the selector query entirely.
              const frames = node.querySelectorAll('iframe, frame');
              for (let i = 0; i < frames.length; i++) {
                if (frames[i].contentWindow) {
                  applyStealth(frames[i].contentWindow);
                }
              }
            }
          } catch (_) {}
        }

        if (origAppendChild) {
          nodeProto.appendChild = createNativeFunction(function appendChild(child) {
            const res = origAppendChild.apply(this, arguments);
            protectNodeIframes(child);
            return res;
          }, 'appendChild', 1, nodeProto);
        }

        if (origInsertBefore) {
          nodeProto.insertBefore = createNativeFunction(function insertBefore(newNode, referenceNode) {
            const res = origInsertBefore.apply(this, arguments);
            protectNodeIframes(newNode);
            return res;
          }, 'insertBefore', 2, nodeProto);
        }

        // Passive srcdoc race backstop (MV3 timing window): assigning
        // iframe.srcdoc = '...' never goes through appendChild/insertBefore,
        // so inline scripts inside the srcdoc document can run before the
        // extension injects. This MutationObserver only re-enters the exact
        // same protection entry (protectNodeIframes) from its microtask
        // callback - it never blocks the page synchronously in the same
        // frame. It also covers insertion paths that bypass the hooks above
        // (append(), replaceWith(), innerHTML, DocumentFragment children).
        // Dedup: applyStealth itself returns early via the per-realm
        // protectedWindows WeakSet and the cross-instance shared patch marks
        // (getSharedPatchMarks), so the contentWindow/contentDocument
        // getter hooks, the insertion hooks, this observer, and the child
        // frame's own engine instance never
        // double-protect the same realm.
        try {
          if (typeof targetWin.MutationObserver === 'function' && targetWin.document) {
            const observerRoot = targetWin.document.documentElement || targetWin.document;
            const srcdocObserver = new targetWin.MutationObserver(function(mutations) {
              for (let i = 0; i < mutations.length; i++) {
                const mut = mutations[i];
                if (mut.type === 'attributes') {
                  protectNodeIframes(mut.target);
                } else if (mut.type === 'childList') {
                  for (let j = 0; j < mut.addedNodes.length; j++) {
                    protectNodeIframes(mut.addedNodes[j]);
                  }
                }
              }
            });
            srcdocObserver.observe(observerRoot, {
              childList: true,
              subtree: true,
              attributeFilter: ['srcdoc']
            });
          }
        } catch (_) {}
      }


    } catch (_) {}

    // 9. Timezone & Intl Localization Protection
    try {
      // --- Real-timezone probe: "no spoof needed" fast path ---
      // The system zone is probed ONCE per realm, here, before any Date/Intl hook
      // in this realm is installed, through the original (still unwrapped) Intl
      // constructor. A nested frame gets its own realm's native zone because
      // applyStealth runs per realm and targetWin.Intl is still pristine at this
      // point.
      //
      // Why this exists: when the spoof target equals the real system zone there
      // is nothing to hide, and *any* re-implementation of Date/Intl (even a
      // faithful one) risks contradicting the native output somewhere (zone-name
      // locale, DST edge instants, sub-minute historical offsets). In that case
      // every hook in this section passes straight through to the native method,
      // so the realm's Date/Intl behaviour is bit-identical to a browser without
      // the extension. Only when the target differs from the real zone (VPN /
      // exit-IP mismatch) is the conversion path activated.
      //
      // Fail-safe: if the probe throws or yields nothing we cannot tell whether
      // the target matches reality, so tzSpoofNeeded stays true and the previous
      // convert-everything behaviour is kept.
      let realTimezone = null;
      try {
        const probeIntl = targetWin.Intl;
        if (probeIntl && probeIntl.DateTimeFormat) {
          const probed = new probeIntl.DateTimeFormat().resolvedOptions();
          if (probed && typeof probed.timeZone === 'string' && probed.timeZone.length > 0) {
            realTimezone = probed.timeZone;
          }
        }
      } catch (_) {
        realTimezone = null;
      }

      let tzSpoofNeeded = true;
      function refreshTzSpoofNeed() {
        // realTimezone is stable for the lifetime of a realm; only the target
        // (activeTimezone) moves when the bridge pushes a new zone.
        tzSpoofNeeded = realTimezone === null || realTimezone !== activeTimezone;
      }
      refreshTzSpoofNeed();

      function updateActiveTimezone(tz) {
        if (typeof tz === 'string' && tz.includes('/')) {
          activeTimezone = tz;
          // A target that now equals the real system zone switches every hook
          // below back to native passthrough (and vice versa when it diverges).
          refreshTzSpoofNeed();
        }
      }

      // Secure bridge channel (protocol v2). The engine (MAIN world,
      // document_start, before any page script) generates a random token and a
      // per-frame random config event name, announces both via '__bocchi_hs__',
      // re-announces on '__bocchi_req__' (the bridge may register its listener
      // only after our first dispatch), and then accepts config payloads only
      // on the random event name and only when the token matches exactly.
      // The previous fixed, guessable event names let any page script forge
      // config events and flip shieldConfig at will.
      if (targetWin.document && targetWin.document.addEventListener) {
        const randomHex = (byteLen) => {
          try {
            if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
              const bytes = new Uint8Array(byteLen);
              crypto.getRandomValues(bytes);
              let out = '';
              for (let i = 0; i < bytes.length; i++) out += (bytes[i] + 0x100).toString(16).slice(1);
              return out;
            }
          } catch (_) {}
          // Fallback entropy: Math.random + Date.now
          let out = '';
          const seed = Date.now();
          for (let i = 0; i < byteLen; i++) {
            const b = (Math.floor(Math.random() * 256) ^ ((seed >>> ((i * 3) % 24)) & 0xff)) & 0xff;
            out += (b + 0x100).toString(16).slice(1);
          }
          return out;
        };
        const bridgeToken = randomHex(16);
        const configEventName = '__bocchi_evt_' + randomHex(8);
        // Once the first authenticated config event arrives, the bridge no
        // longer needs the handshake; any later '__bocchi_req__' can only be a
        // page script fishing for the token, so re-dispatching is disabled.
        let handshakeArmed = true;

        const dispatchHandshake = () => {
          try {
            const detail = { t: bridgeToken, e: configEventName };
            let evt = null;
            try {
              evt = new targetWin.CustomEvent('__bocchi_hs__', { detail: detail });
            } catch (_) {
              evt = new CustomEvent('__bocchi_hs__', { detail: detail });
            }
            targetWin.document.dispatchEvent(evt);
          } catch (_) {}
        };

        targetWin.document.addEventListener('__bocchi_req__', function() {
          if (handshakeArmed) dispatchHandshake();
        }, true);

        targetWin.document.addEventListener(configEventName, function(e) {
          if (!e || !e.detail || e.detail.t !== bridgeToken) return;
          handshakeArmed = false;
          const d = e.detail;
          if (typeof d.tz === 'string') {
            updateActiveTimezone(d.tz);
          }
          if (d.fonts && typeof d.fonts === 'object') {
            const f = d.fonts;
            if (Array.isArray(f.customFonts)) {
              fontConfig.customHiddenFonts = f.customFonts.slice();
            }
            if (Array.isArray(f.allowedFonts)) {
              fontConfig.customAllowedFonts = f.allowedFonts.slice();
            }
            if (typeof f.blockBuiltin === 'boolean') {
              fontConfig.blockBuiltinChineseFonts = f.blockBuiltin;
            }
            if (typeof f.fontMode === 'string') {
              fontConfig.fontMode = f.fontMode;
            }
            if (typeof f.blockOtherScripts === 'boolean') {
              fontConfig.blockOtherScripts = f.blockOtherScripts;
            }
            if (typeof f.fontProtection === 'boolean') {
              shieldConfig.fontProtection = f.fontProtection;
            }
          }
          if (d.cfg && typeof d.cfg === 'object') {
            const c = d.cfg;
            if (typeof c.globalShieldEnabled === 'boolean') {
              shieldConfig.globalShieldEnabled = c.globalShieldEnabled;
            }
            if (typeof c.isBypassed === 'boolean') {
              shieldConfig.isBypassed = c.isBypassed;
            }
            if (Array.isArray(c.siteBypassList)) {
              shieldConfig.siteBypassList = c.siteBypassList.slice();
            }
            if (typeof c.canvasProtection === 'boolean') {
              shieldConfig.canvasProtection = c.canvasProtection;
            }
            if (typeof c.webrtcProtection === 'boolean') {
              shieldConfig.webrtcProtection = c.webrtcProtection;
            }
            if (typeof c.audioProtection === 'boolean') {
              shieldConfig.audioProtection = c.audioProtection;
            }
            if (typeof c.timezoneProtection === 'boolean') {
              shieldConfig.timezoneProtection = c.timezoneProtection;
            }
            if (typeof c.hardwareProtection === 'boolean') {
              shieldConfig.hardwareProtection = c.hardwareProtection;
            }
            if (typeof c.fontProtection === 'boolean') {
              shieldConfig.fontProtection = c.fontProtection;
            }
            if (typeof c.blockOtherScripts === 'boolean') {
              fontConfig.blockOtherScripts = c.blockOtherScripts;
            }
          }
          // Bypass decisions may have changed; drop the per-window cache.
          shieldStateCache = new WeakMap();
        }, true);

        // Immediate handshake at document_start. If the bridge has not
        // registered yet it misses this and recovers via '__bocchi_req__'.
        dispatchHandshake();
      }

      // Caching and zoned calculation helpers
      const dtfCache = new Map();
      function getCachedDTF(tz, opts) {
        const key = tz + JSON.stringify(opts);
        if (!dtfCache.has(key)) {
          dtfCache.set(key, new Intl.DateTimeFormat('en-US', Object.assign({ timeZone: tz }, opts)));
        }
        return dtfCache.get(key);
      }

      let lastDateT = NaN;
      let lastDateTz = '';
      let lastZonedParts = null;

      const monthsShort = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
      const weekdayMap = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

      // Keep the pristine constructor in the closure (applyStealth runs once per realm,
      // guarded by protectedWindows, so no re-entrancy and no brand-key export needed).
      const OrigDate = targetWin.Date || Date;
      const origGetTime = OrigDate && OrigDate.prototype ? OrigDate.prototype.getTime : null;

      function getZonedParts(date, tz) {
        if (!origGetTime) return null;
        const t = origGetTime.call(date);
        if (isNaN(t)) return null;

        const targetTz = tz || activeTimezone;
        if (t === lastDateT && targetTz === lastDateTz && lastZonedParts) {
          return lastZonedParts;
        }

        try {
          const dtf = getCachedDTF(targetTz, {
            hourCycle: 'h23',
            year: 'numeric',
            month: 'numeric',
            day: 'numeric',
            weekday: 'short',
            hour: 'numeric',
            minute: 'numeric',
            second: 'numeric',
            timeZoneName: 'long'
          });
          const parts = dtf.formatToParts(date);
          const m = {};
          for (let i = 0; i < parts.length; i++) {
            m[parts[i].type] = parts[i].value;
          }

          const year = parseInt(m.year, 10);
          const month = parseInt(m.month, 10) - 1;
          const day = parseInt(m.day, 10);
          const hour = parseInt(m.hour, 10) % 24;
          const minute = parseInt(m.minute, 10);
          const second = parseInt(m.second, 10);
          const weekday = weekdayMap[m.weekday] !== undefined ? weekdayMap[m.weekday] : 0;

          const ms = ((t % 1000) + 1000) % 1000;
          // The millisecond remainder must be part of the wall-as-UTC instant, or
          // every offset would carry a sub-minute epsilon and truncation below
          // would report e.g. GMT+0759 for Asia/Shanghai.
          const asUTC = Date.UTC(year, month, day, hour, minute, second, ms);
          // Wall->epoch resolution keeps minute-rounded offsets, but the offset we
          // *report* (getTimezoneOffset / toString's GMT field) must match V8,
          // which truncates toward zero for zones with sub-minute LMT-era offsets
          // (verified against native: Africa/Monrovia 1969 => 44, not 45;
          // Asia/Shanghai 1900 => GMT+0805, not GMT+0806).
          const offsetExactMin = (t - asUTC) / 60000;
          const offsetMin = Math.round(offsetExactMin);
          const reportedOffsetMin = Math.trunc(offsetExactMin);

          const absOffset = Math.abs(reportedOffsetMin);
          const offH = String(Math.floor(absOffset / 60)).padStart(2, '0');
          const offM = String(absOffset % 60).padStart(2, '0');
          const sign = reportedOffsetMin <= 0 ? '+' : '-';
          const gmtStr = 'GMT' + sign + offH + offM;

          const res = {
            year,
            month,
            day,
            hour,
            minute,
            second,
            ms,
            weekday,
            weekdayShort: m.weekday,
            timeZoneName: m.timeZoneName || gmtStr,
            offsetMin,
            reportedOffsetMin,
            gmtStr
          };
          lastDateT = t;
          lastDateTz = targetTz;
          lastZonedParts = res;
          return res;
        } catch (_) {
          return null;
        }
      }

      // Native Date Prototype Hooking
      if (OrigDate && OrigDate.prototype) {
        const origDateToString = OrigDate.prototype.toString;
        const origDateToTimeString = OrigDate.prototype.toTimeString;
        const origDateToDateString = OrigDate.prototype.toDateString;
        const origDateToLocaleString = OrigDate.prototype.toLocaleString;
        const origDateToLocaleDateString = OrigDate.prototype.toLocaleDateString;
        const origDateToLocaleTimeString = OrigDate.prototype.toLocaleTimeString;
        const origDateGetTimezoneOffset = OrigDate.prototype.getTimezoneOffset;
        const origDateGetHours = OrigDate.prototype.getHours;
        const origDateGetMinutes = OrigDate.prototype.getMinutes;
        const origDateGetSeconds = OrigDate.prototype.getSeconds;
        const origDateGetDate = OrigDate.prototype.getDate;
        const origDateGetDay = OrigDate.prototype.getDay;
        const origDateGetMonth = OrigDate.prototype.getMonth;
        const origDateGetFullYear = OrigDate.prototype.getFullYear;
        const origDateGetYear = OrigDate.prototype.getYear;
        const origDateSetHours = OrigDate.prototype.setHours;
        const origDateSetMinutes = OrigDate.prototype.setMinutes;
        const origDateSetSeconds = OrigDate.prototype.setSeconds;
        const origDateSetDate = OrigDate.prototype.setDate;
        const origDateSetMonth = OrigDate.prototype.setMonth;
        const origDateSetFullYear = OrigDate.prototype.setFullYear;

        // V8 reports the method name in this TypeError
        // ("Method Date.prototype.<name> called on incompatible receiver").
        function checkDateReceiver(receiver, methodName) {
          if (!(receiver instanceof OrigDate) && Object.prototype.toString.call(receiver) !== '[object Date]') {
            throw new TypeError('Method Date.prototype.' + methodName + ' called on incompatible receiver');
          }
        }

        // getTimezoneOffset
        OrigDate.prototype.getTimezoneOffset = createNativeFunction(function getTimezoneOffset() {
          checkDateReceiver(this, 'getTimezoneOffset');
          // tzSpoofNeeded false => the target matches the real system zone; fall
          // through to the native method so the result cannot differ from a
          // browser without the extension.
          if (!isShieldActive('timezoneProtection') || !tzSpoofNeeded) {
            return origDateGetTimezoneOffset.call(this);
          }
          const parts = getZonedParts(this, activeTimezone);
          if (!parts) {
            const t = origGetTime.call(this);
            return isNaN(t) ? NaN : 0;
          }
          // V8 truncates sub-minute offsets toward zero (see getZonedParts).
          return parts.reportedOffsetMin;
        }, 'getTimezoneOffset', 0);

        // toString
        OrigDate.prototype.toString = createNativeFunction(function toString() {
          checkDateReceiver(this, 'toString');
          if (!isShieldActive('timezoneProtection') || !tzSpoofNeeded) {
            return origDateToString.call(this);
          }
          const parts = getZonedParts(this, activeTimezone);
          if (!parts) {
            origGetTime.call(this);
            return 'Invalid Date';
          }
          const dayStr = String(parts.day).padStart(2, '0');
          const hourStr = String(parts.hour).padStart(2, '0');
          const minStr = String(parts.minute).padStart(2, '0');
          const secStr = String(parts.second).padStart(2, '0');
          return `${parts.weekdayShort} ${monthsShort[parts.month]} ${dayStr} ${parts.year} ${hourStr}:${minStr}:${secStr} ${parts.gmtStr} (${parts.timeZoneName})`;
        }, 'toString', 0);

        // toTimeString
        OrigDate.prototype.toTimeString = createNativeFunction(function toTimeString() {
          checkDateReceiver(this, 'toTimeString');
          if (!isShieldActive('timezoneProtection') || !tzSpoofNeeded) {
            return origDateToTimeString.call(this);
          }
          const parts = getZonedParts(this, activeTimezone);
          if (!parts) {
            origGetTime.call(this);
            return 'Invalid Date';
          }
          const hourStr = String(parts.hour).padStart(2, '0');
          const minStr = String(parts.minute).padStart(2, '0');
          const secStr = String(parts.second).padStart(2, '0');
          return `${hourStr}:${minStr}:${secStr} ${parts.gmtStr} (${parts.timeZoneName})`;
        }, 'toTimeString', 0);

        // toDateString
        OrigDate.prototype.toDateString = createNativeFunction(function toDateString() {
          checkDateReceiver(this, 'toDateString');
          if (!isShieldActive('timezoneProtection') || !tzSpoofNeeded) {
            return origDateToDateString.call(this);
          }
          const parts = getZonedParts(this, activeTimezone);
          if (!parts) {
            origGetTime.call(this);
            return 'Invalid Date';
          }
          const dayStr = String(parts.day).padStart(2, '0');
          return `${parts.weekdayShort} ${monthsShort[parts.month]} ${dayStr} ${parts.year}`;
        }, 'toDateString', 0);

        // toLocaleString
        OrigDate.prototype.toLocaleString = createNativeFunction(function toLocaleString(locales, options) {
          checkDateReceiver(this, 'toLocaleString');
          if (!isShieldActive('timezoneProtection') || !tzSpoofNeeded) {
            return origDateToLocaleString.apply(this, arguments);
          }
          const t = origGetTime.call(this);
          if (isNaN(t)) return 'Invalid Date';
          // Locale passes through natively (entropy-reduction strategy); only
          // the timezone is aligned with the exit IP.
          const opts = Object.assign({}, options);
          if (!opts.timeZone) {
            opts.timeZone = activeTimezone;
          }
          return origDateToLocaleString.call(this, locales, opts);
        }, 'toLocaleString', 0);

        // toLocaleDateString
        OrigDate.prototype.toLocaleDateString = createNativeFunction(function toLocaleDateString(locales, options) {
          checkDateReceiver(this, 'toLocaleDateString');
          if (!isShieldActive('timezoneProtection') || !tzSpoofNeeded) {
            return origDateToLocaleDateString.apply(this, arguments);
          }
          const t = origGetTime.call(this);
          if (isNaN(t)) return 'Invalid Date';
          const opts = Object.assign({}, options);
          if (!opts.timeZone) {
            opts.timeZone = activeTimezone;
          }
          return origDateToLocaleDateString.call(this, locales, opts);
        }, 'toLocaleDateString', 0);

        // toLocaleTimeString
        OrigDate.prototype.toLocaleTimeString = createNativeFunction(function toLocaleTimeString(locales, options) {
          checkDateReceiver(this, 'toLocaleTimeString');
          if (!isShieldActive('timezoneProtection') || !tzSpoofNeeded) {
            return origDateToLocaleTimeString.apply(this, arguments);
          }
          const t = origGetTime.call(this);
          if (isNaN(t)) return 'Invalid Date';
          const opts = Object.assign({}, options);
          if (!opts.timeZone) {
            opts.timeZone = activeTimezone;
          }
          return origDateToLocaleTimeString.call(this, locales, opts);
        }, 'toLocaleTimeString', 0);

        // Local Date getters
        const origDateGettersMap = {
          getHours: origDateGetHours,
          getMinutes: origDateGetMinutes,
          getSeconds: origDateGetSeconds,
          getDate: origDateGetDate,
          getDay: origDateGetDay,
          getMonth: origDateGetMonth,
          getFullYear: origDateGetFullYear,
          getYear: origDateGetYear
        };
        [
          ['getHours', 'hour'],
          ['getMinutes', 'minute'],
          ['getSeconds', 'second'],
          ['getDate', 'day'],
          ['getDay', 'weekday'],
          ['getMonth', 'month'],
          ['getFullYear', 'year'],
          ['getYear', 'year', y => y - 1900]
        ].forEach(([fnName, prop, transform]) => {
          OrigDate.prototype[fnName] = createNativeFunction(function() {
            checkDateReceiver(this, fnName);
            if (!isShieldActive('timezoneProtection') || !tzSpoofNeeded) {
              return origDateGettersMap[fnName].call(this);
            }
            const p = getZonedParts(this, activeTimezone);
            return p ? (transform ? transform(p[prop]) : p[prop]) : (origGetTime.call(this), NaN);
          }, fnName, 0);
        });

        // Native Date Local Setters
        const origSetTime = OrigDate.prototype.setTime;

        // Resolve a target wall time to an epoch the way V8 does (verified against
        // native zone data for America/Los_Angeles, America/New_York,
        // Europe/London, Europe/Berlin, Australia/Sydney, Pacific/Chatham,
        // Asia/Kolkata and Asia/Shanghai incl. their 1988 DST era): an
        // unambiguous wall uses its true offset, the repeated hour of a
        // fall-back transition keeps the EARLIER instant, and a wall inside a
        // spring-forward gap is shifted forward by the gap length (equivalent to
        // resolving with the pre-transition offset).
        //
        // The only two offsets that can apply are the offsets in effect one day
        // before and one day after the naive wall instant; a single probe on each
        // side brackets any transition (including 30/45-minute DST zones) with a
        // fixed, tiny number of lookups. The previous candidate set was seeded
        // from the caller's guess / the wall-as-UTC instant only, so when all of
        // those landed on the post-transition side the pre-transition offset was
        // never tested and the ambiguous hour resolved one hour late versus
        // native (reproduced for Europe/London 2025-10-26 01:30,
        // Europe/Berlin 2025-10-26 02:30, Australia/Sydney 2025-04-06 02:30 and
        // Asia/Shanghai 1988-09-11 01:30).
        function resolveWallTime(naiveUtc, firstGuessOffset) {
          const offsetAt = (t) => {
            const p = getZonedParts(new OrigDate(t), activeTimezone);
            return p ? p.offsetMin : null;
          };
          const before = offsetAt(naiveUtc - 86400000);
          const after = offsetAt(naiveUtc + 86400000);
          const guess = (typeof firstGuessOffset === 'number' && !isNaN(firstGuessOffset)) ? firstGuessOffset : 0;
          if (before === null && after === null) {
            // Zone lookup unavailable (e.g. NaN wall clock): keep the caller's
            // estimate instead of inventing one.
            return naiveUtc + guess * 60000;
          }
          const candidates = [];
          if (before !== null) candidates.push(before);
          if (after !== null && after !== before) candidates.push(after);
          let earliest = null;
          for (let i = 0; i < candidates.length; i++) {
            const t = naiveUtc + candidates[i] * 60000;
            // A candidate is real iff the zone's offset at the resulting instant
            // is exactly that candidate (i.e. the wall clock round-trips).
            if (offsetAt(t) === candidates[i] && (earliest === null || t < earliest)) {
              earliest = t;
            }
          }
          if (earliest !== null) return earliest;
          // No candidate round-trips: the requested wall clock does not exist
          // (spring-forward gap). V8 resolves it with the pre-transition offset,
          // pushing the result past the gap; that offset is `before`.
          return naiveUtc + (before !== null ? before : after) * 60000;
        }

        function updateDateZoned(date, updater, methodName) {
          checkDateReceiver(date, methodName);
          const p = getZonedParts(date, activeTimezone);
          if (!p) {
            origGetTime.call(date);
            return NaN;
          }
          const updated = Object.assign({}, p);
          updater(updated);
          const yr = (updated.year >= 0 && updated.year < 100) ? 1900 + updated.year : updated.year;
          const naiveUtc = OrigDate.UTC(yr, updated.month, updated.day, updated.hour, updated.minute, updated.second, updated.ms || 0);
          // DST-safe wall -> epoch mapping (V8-matching; see resolveWallTime)
          const newT = resolveWallTime(naiveUtc, updated.offsetMin);
          origSetTime.call(date, newT);
          return newT;
        }

        OrigDate.prototype.setHours = createNativeFunction(function setHours(h, m, s, ms) {
          if (!isShieldActive('timezoneProtection') || !tzSpoofNeeded) {
            return origDateSetHours.apply(this, arguments);
          }
          return updateDateZoned(this, p => {
            p.hour = Number(h);
            if (m !== undefined) p.minute = Number(m);
            if (s !== undefined) p.second = Number(s);
            if (ms !== undefined) p.ms = Number(ms);
          }, 'setHours');
        }, 'setHours', 1);

        OrigDate.prototype.setMinutes = createNativeFunction(function setMinutes(m, s, ms) {
          if (!isShieldActive('timezoneProtection') || !tzSpoofNeeded) {
            return origDateSetMinutes.apply(this, arguments);
          }
          return updateDateZoned(this, p => {
            p.minute = Number(m);
            if (s !== undefined) p.second = Number(s);
            if (ms !== undefined) p.ms = Number(ms);
          }, 'setMinutes');
        }, 'setMinutes', 1);

        OrigDate.prototype.setSeconds = createNativeFunction(function setSeconds(s, ms) {
          if (!isShieldActive('timezoneProtection') || !tzSpoofNeeded) {
            return origDateSetSeconds.apply(this, arguments);
          }
          return updateDateZoned(this, p => {
            p.second = Number(s);
            if (ms !== undefined) p.ms = Number(ms);
          }, 'setSeconds');
        }, 'setSeconds', 1);

        OrigDate.prototype.setDate = createNativeFunction(function setDate(d) {
          if (!isShieldActive('timezoneProtection') || !tzSpoofNeeded) {
            return origDateSetDate.apply(this, arguments);
          }
          return updateDateZoned(this, p => {
            p.day = Number(d);
          }, 'setDate');
        }, 'setDate', 1);

        OrigDate.prototype.setMonth = createNativeFunction(function setMonth(m, d) {
          if (!isShieldActive('timezoneProtection') || !tzSpoofNeeded) {
            return origDateSetMonth.apply(this, arguments);
          }
          return updateDateZoned(this, p => {
            p.month = Number(m);
            if (d !== undefined) p.day = Number(d);
          }, 'setMonth');
        }, 'setMonth', 1);

        OrigDate.prototype.setFullYear = createNativeFunction(function setFullYear(y, m, d) {
          if (!isShieldActive('timezoneProtection') || !tzSpoofNeeded) {
            return origDateSetFullYear.apply(this, arguments);
          }
          return updateDateZoned(this, p => {
            p.year = Number(y);
            if (m !== undefined) p.month = Number(m);
            if (d !== undefined) p.day = Number(d);
          }, 'setFullYear');
        }, 'setFullYear', 1);

        // Hook targetWin.Date constructor and function call
        const HookedDate = function Date(...args) {
          if (!new.target) {
            // No spoof needed => the native toString (same call the unwrapped
            // Date() makes) is the only correct answer.
            const d = new OrigDate();
            return (!isShieldActive('timezoneProtection') || !tzSpoofNeeded) ? origDateToString.call(d) : OrigDate.prototype.toString.call(d);
          }
          // Wall-clock constructor args only need remapping when the target zone
          // differs from the real one; otherwise let Reflect.construct take the
          // untouched native path below.
          if (args.length >= 2 && isShieldActive('timezoneProtection') && tzSpoofNeeded) {
            try {
              const yr = Number(args[0]);
              const mo = Number(args[1]);
              const da = args.length > 2 ? Number(args[2]) : 1;
              const hr = args.length > 3 ? Number(args[3]) : 0;
              const mi = args.length > 4 ? Number(args[4]) : 0;
              const se = args.length > 5 ? Number(args[5]) : 0;
              const ms = args.length > 6 ? Number(args[6]) : 0;
              const fullYr = (yr >= 0 && yr < 100) ? 1900 + yr : yr;
              const naiveUtc = OrigDate.UTC(fullYr, mo, da, hr, mi, se, ms);
              // DST-safe wall -> epoch mapping (V8-matching; see resolveWallTime)
              const guessP = getZonedParts(new OrigDate(naiveUtc), activeTimezone);
              const targetMs = resolveWallTime(naiveUtc, guessP ? guessP.offsetMin : 0);
              return Reflect.construct(OrigDate, [targetMs], new.target);
            } catch (_) {}
          }
          return Reflect.construct(OrigDate, args, new.target);
        };

        HookedDate.prototype = OrigDate.prototype;
        try {
          OrigDate.prototype.constructor = HookedDate;
        } catch (_) {}
        Object.setPrototypeOf(HookedDate, OrigDate);

        ['now', 'parse', 'UTC'].forEach(prop => {
          try {
            const desc = Object.getOwnPropertyDescriptor(OrigDate, prop);
            if (desc) Object.defineProperty(HookedDate, prop, desc);
          } catch (_) {}
        });

        makeNative(HookedDate, 'Date', 7);

        try {
          Object.defineProperty(targetWin, 'Date', {
            value: HookedDate,
            writable: true,
            enumerable: false,
            configurable: true
          });
        } catch (_) {
          targetWin.Date = HookedDate;
        }
      }

      // Native Intl Hooking
      if (targetWin.Intl) {
        const OrigIntl = targetWin.Intl;
        const defaultTzInstances = new WeakSet();

        // DateTimeFormat
        if (OrigIntl.DateTimeFormat) {
          const OrigDTF = OrigIntl.DateTimeFormat;
          function DateTimeFormat(locales, options) {
            if (!isShieldActive('timezoneProtection') || !tzSpoofNeeded) {
              // Target zone == real system zone (or protection off): construct
              // through the original constructor so the instance, its resolved
              // options and every formatted string are exactly native.
              return new.target ? Reflect.construct(OrigDTF, arguments, new.target) : OrigDTF.apply(this, arguments);
            }
            // Locale passes through natively (entropy-reduction strategy); only
            // the timezone is aligned with the exit IP.
            const hasExplicitTz = !!(options && options.timeZone);
            const opts = Object.assign({}, options);
            if (!opts.timeZone) {
              opts.timeZone = activeTimezone;
            }
            const inst = new.target ? Reflect.construct(OrigDTF, [locales, opts], new.target) : OrigDTF(locales, opts);
            if (!hasExplicitTz) {
              defaultTzInstances.add(inst);
            }
            return inst;
          }

          DateTimeFormat.prototype = OrigDTF.prototype;
          if (OrigDTF.supportedLocalesOf) {
            DateTimeFormat.supportedLocalesOf = OrigDTF.supportedLocalesOf;
          }
          makeNative(DateTimeFormat, 'DateTimeFormat', OrigDTF.length);

          const origDTFResolved = OrigDTF.prototype.resolvedOptions;
          if (origDTFResolved) {
            // Real local timezone, derived dynamically through the original (unhooked)
            // constructor. Replaces the old hardcoded Chinese-city list, which missed
            // zones like Asia/Macau.
            // Reuse the realm-level probe when it succeeded (single source of
            // truth for "the zone this machine is really in"); fall back to a
            // local probe of the pristine resolvedOptions otherwise.
            let realLocalTz = realTimezone;
            if (!realLocalTz) {
              try {
                realLocalTz = origDTFResolved.call(new OrigDTF()).timeZone || null;
              } catch (_) {}
            }
            // Long display name ("Pacific Daylight Time") derived from activeTimezone
            // with the original Intl constructor, so a replaced timeZone stays
            // consistent with any timeZoneName the formatter resolved.
            const getSpoofedTzName = () => {
              try {
                const parts = new OrigDTF('en-US', { timeZone: activeTimezone, timeZoneName: 'long' }).formatToParts(OrigDate.now());
                for (let i = 0; i < parts.length; i++) {
                  if (parts[i].type === 'timeZoneName') return parts[i].value;
                }
              } catch (_) {}
              return null;
            };
            const hookedDTFResolved = createNativeFunction(function resolvedOptions() {
              const res = origDTFResolved.apply(this, arguments);
              if (!isShieldActive('timezoneProtection') || !tzSpoofNeeded) {
                // Nothing to rewrite: report the untouched native resolved options.
                return res;
              }
              if (res) {
                if (defaultTzInstances.has(this) || !res.timeZone || (realLocalTz && res.timeZone === realLocalTz)) {
                  res.timeZone = activeTimezone;
                  if (res.timeZoneName) {
                    const spoofedName = getSpoofedTzName();
                    if (spoofedName) {
                      res.timeZoneName = spoofedName;
                    }
                  }
                }
              }
              return res;
            }, 'resolvedOptions', 0, OrigDTF.prototype);
            OrigDTF.prototype.resolvedOptions = hookedDTFResolved;
          }

          OrigIntl.DateTimeFormat = DateTimeFormat;
        }
      }
    } catch (_) {}

    // 10. Web Worker & SharedWorker Cross-Context Protection
    try {
      // Mirror the main-thread degradation (hardwareConcurrency is a fixed
      // common value on both sides — no CYT special-casing).
      const workerConcurrency = 8;

      function generateWorkerBootstrap() {
        return `(function() {
  'use strict';
  try {
    const chosenConcurrency = ${workerConcurrency};
    const targetTz = ${JSON.stringify(activeTimezone)};

    // Self-contained native-look patch: without this, String(hookFn) inside the
    // worker reveals this bootstrap source. Keeps every hook function's
    // Function.prototype.toString output looking native.
    const origFnToString = Function.prototype.toString;
    const nativeTextMap = new WeakMap();
    const makeNative = function(fn, fnName) {
      try {
        nativeTextMap.set(fn, 'function ' + (fnName || (fn && fn.name) || '') + '() { [native code] }');
      } catch (_) {}
      return fn;
    };
    const patchedFnToString = function toString() {
      if (this === patchedFnToString) return 'function toString() { [native code] }';
      if (nativeTextMap.has(this)) return nativeTextMap.get(this);
      return origFnToString.apply(this, arguments);
    };
    makeNative(patchedFnToString, 'toString');
    Function.prototype.toString = patchedFnToString;

    const nav = self.navigator;
    const navProto = (self.WorkerNavigator && self.WorkerNavigator.prototype) ||
                     (self.Navigator && self.Navigator.prototype) ||
                     (nav ? Object.getPrototypeOf(nav) : null);

    const defineProp = (proto, obj, prop, getVal) => {
      const getter = makeNative(function() { return getVal(); }, 'get ' + prop);
      try {
        if (proto) {
          Object.defineProperty(proto, prop, {
            get: getter,
            set: undefined,
            enumerable: true,
            configurable: true
          });
        } else if (obj) {
          Object.defineProperty(obj, prop, {
            get: getter,
            set: undefined,
            enumerable: true,
            configurable: true
          });
        }
      } catch (_) {
        try { if (obj) obj[prop] = getVal(); } catch (__) {}
      }
    };

    // Only hardware values stay spoofed here, mirroring the main-thread
    // navigator hooks (deviceMemory / hardwareConcurrency); UA-family persona
    // values are native on both the main thread and workers now.
    defineProp(navProto, nav, 'hardwareConcurrency', () => chosenConcurrency);
    defineProp(navProto, nav, 'deviceMemory', () => 8);

    // performance.memory in worker
    if (self.performance && self.performance.memory) {
      try {
        const pmProto = Object.getPrototypeOf(self.performance.memory);
        if (pmProto) {
          Object.defineProperty(pmProto, 'jsHeapSizeLimit', {
            get: makeNative(function() { return 2172649472; }, 'get jsHeapSizeLimit'),
            enumerable: true,
            configurable: true
          });
        }
      } catch (_) {}
    }

    // Intl in worker: timezone consistency only — default any missing
    // timeZone to targetTz and report it via resolvedOptions. Locale
    // handling stays fully native.
    if (self.Intl && self.Intl.DateTimeFormat) {
      const origDTF = self.Intl.DateTimeFormat;
      function HookedDTF(locales, options) {
        const opts = Object.assign({}, options);
        if (!opts.timeZone) opts.timeZone = targetTz;
        return origDTF.call(this, locales, opts);
      }
      HookedDTF.prototype = origDTF.prototype;
      HookedDTF.supportedLocalesOf = origDTF.supportedLocalesOf;
      makeNative(HookedDTF, 'DateTimeFormat');
      self.Intl.DateTimeFormat = HookedDTF;
      const origResolved = origDTF.prototype.resolvedOptions;
      origDTF.prototype.resolvedOptions = makeNative(function() {
        const res = origResolved.apply(this, arguments);
        if (res) {
          res.timeZone = targetTz;
        }
        return res;
      }, 'resolvedOptions');
    }

    // Date timezone and string formatting in worker
    if (self.Date && self.Date.prototype) {
      const origGetTimezoneOffset = self.Date.prototype.getTimezoneOffset;
      const origToString = self.Date.prototype.toString;
      const monthsShort = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
      const daysShort = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

      function getWorkerZonedParts(date) {
        try {
          const dtf = new Intl.DateTimeFormat('en-US', {
            timeZone: targetTz,
            year: 'numeric', month: 'numeric', day: 'numeric',
            hour: 'numeric', minute: 'numeric', second: 'numeric',
            hour12: false
          });
          const parts = dtf.formatToParts(date);
          const m = {};
          for (let i = 0; i < parts.length; i++) m[parts[i].type] = parts[i].value;
          const asUTC = Date.UTC(
            parseInt(m.year, 10),
            parseInt(m.month, 10) - 1,
            parseInt(m.day, 10),
            parseInt(m.hour === '24' ? '0' : m.hour, 10),
            parseInt(m.minute, 10),
            parseInt(m.second, 10)
          );
          const offsetMin = Math.round((date.getTime() - asUTC) / 60000);
          const tzDtf = new Intl.DateTimeFormat('en-US', { timeZone: targetTz, timeZoneName: 'long' });
          const tzParts = tzDtf.formatToParts(date);
          const tzNamePart = tzParts.find(p => p.type === 'timeZoneName');
          const tzName = tzNamePart ? tzNamePart.value : targetTz;
          const sign = offsetMin <= 0 ? '+' : '-';
          const absMin = Math.abs(offsetMin);
          const offH = String(Math.floor(absMin / 60)).padStart(2, '0');
          const offM = String(absMin % 60).padStart(2, '0');
          const gmtStr = 'GMT' + sign + offH + offM;
          const dObj = new Date(asUTC);
          return {
            year: m.year,
            month: parseInt(m.month, 10) - 1,
            day: String(m.day).padStart(2, '0'),
            hour: String(m.hour === '24' ? '0' : m.hour).padStart(2, '0'),
            minute: String(m.minute).padStart(2, '0'),
            second: String(m.second).padStart(2, '0'),
            weekdayShort: daysShort[dObj.getUTCDay()],
            monthShort: monthsShort[parseInt(m.month, 10) - 1],
            offsetMin: offsetMin,
            gmtStr: gmtStr,
            tzName: tzName
          };
        } catch (_) {
          return null;
        }
      }

      self.Date.prototype.getTimezoneOffset = makeNative(function() {
        const parts = getWorkerZonedParts(this);
        return parts ? parts.offsetMin : (origGetTimezoneOffset ? origGetTimezoneOffset.call(this) : 420);
      }, 'getTimezoneOffset');

      self.Date.prototype.toString = makeNative(function() {
        const parts = getWorkerZonedParts(this);
        if (!parts) return origToString ? origToString.call(this) : '';
        return parts.weekdayShort + ' ' + parts.monthShort + ' ' + parts.day + ' ' + parts.year + ' ' + parts.hour + ':' + parts.minute + ':' + parts.second + ' ' + parts.gmtStr + ' (' + parts.tzName + ')';
      }, 'toString');

      self.Date.prototype.toTimeString = makeNative(function() {
        const parts = getWorkerZonedParts(this);
        if (!parts) return '';
        return parts.hour + ':' + parts.minute + ':' + parts.second + ' ' + parts.gmtStr + ' (' + parts.tzName + ')';
      }, 'toTimeString');
    }

    // self.fonts in worker
    if (self.fonts && typeof self.fonts.check === 'function') {
      const origFontsCheck = self.fonts.check;
      self.fonts.check = makeNative(function(font, text) {
        if (typeof font === 'string') {
          if (/(?:simsun|nsimsun|simhei|yahei|wenquanyi|pingfang|kaiti|fangsong)/i.test(font)) return false;
        }
        return origFontsCheck.apply(this, arguments);
      }, 'check');
    }

    // OffscreenCanvas WebGL in worker
    if (typeof self.OffscreenCanvas !== 'undefined' && self.OffscreenCanvas.prototype && self.OffscreenCanvas.prototype.getContext) {
      const origOCGetContext = self.OffscreenCanvas.prototype.getContext;
      self.OffscreenCanvas.prototype.getContext = makeNative(function(type, attribs) {
        const ctx = origOCGetContext.apply(this, arguments);
        if (ctx && (type === 'webgl' || type === 'experimental-webgl' || type === 'webgl2')) {
          const origGP = ctx.getParameter;
          ctx.getParameter = makeNative(function(pname) {
            if (pname === 0x1F00) return 'WebKit';
            if (pname === 0x1F01) return 'WebKit WebGL';
            // Same pooled GPU profile as the main thread (interpolated from the
            // applyStealth-scope gpuProfile) — a worker reporting a different
            // renderer than its page is a cross-context contradiction and would
            // be a detection point. Pool strings are plain literals (no quotes
            // or backslashes), so single-quoted interpolation is safe here.
            if (pname === 37445) return '${GPU_VENDOR_WEBGL}';
            if (pname === 37446) return '${gpuProfile.renderer}';
            // MAX_TEXTURE_SIZE: keep worker reads identical to the main-thread
            // GPU persona (16384, crowd-common for these Intel GPUs).
            if (pname === 0x0D33) return 16384;
            return origGP.apply(this, arguments);
          }, 'getParameter');
        }
        return ctx;
      }, 'getContext');
    }
  } catch (_) {}
})();`;
      }

      // Blob URLs created for worker bootstrap wrapping; revoked once on
      // pagehide. No per-worker immediate revoke: dynamically importScripts-ing
      // workers would break if their blob URL disappeared mid-flight.
      const workerBlobURLs = new Set();
      if (typeof targetWin.addEventListener === 'function') {
        targetWin.addEventListener('pagehide', function() {
          for (const blobURL of workerBlobURLs) {
            try { targetWin.URL.revokeObjectURL(blobURL); } catch (_) {}
          }
          workerBlobURLs.clear();
        }, { once: true, passive: true });
      }

      function wrapWorkerScript(scriptURL, options) {
        if (!isShieldActive()) return { wrappedURL: scriptURL, isWrapped: false };
        if (scriptURL === undefined || scriptURL === null) return { wrappedURL: scriptURL, isWrapped: false };
        const urlStr = String(scriptURL);
        let resolvedURL = urlStr;
        try {
          resolvedURL = new targetWin.URL(urlStr, targetWin.location.href).href;
        } catch (_) {}

        const isModule = (typeof options === 'object' && options !== null && options.type === 'module');
        const bootstrap = generateWorkerBootstrap();
        const importCode = isModule
          ? `import ${JSON.stringify(resolvedURL)};`
          : `importScripts(${JSON.stringify(resolvedURL)});`;
        const fullSource = bootstrap + '\n' + importCode;

        if (targetWin.Blob && targetWin.URL && targetWin.URL.createObjectURL) {
          try {
            const blob = new targetWin.Blob([fullSource], { type: 'application/javascript' });
            const blobURL = targetWin.URL.createObjectURL(blob);
            try { workerBlobURLs.add(blobURL); } catch (_) {}
            return { wrappedURL: blobURL, isWrapped: true };
          } catch (_) {}
        }
        return { wrappedURL: scriptURL, isWrapped: false };
      }

      // Hook targetWin.Worker & SharedWorker
      ['Worker', 'SharedWorker'].forEach(name => {
        if (typeof targetWin[name] === 'function') {
          const OrigWorker = targetWin[name];
          const isShared = (name === 'SharedWorker');
          const HookedWorker = createNativeConstructor(function(newTarget, args) {
            const scriptURL = args[0];
            const options = args[1];

            let newArgs = args;
            let isWrapped = false;
            let wrappedURL = scriptURL;

            // SharedWorker wrapping is intentionally skipped (kept unwrapped):
            // Chrome *does* construct and run SharedWorker from a blob: URL, but
            // shared-worker identity is (origin, script URL, name), and every
            // URL.createObjectURL() mints a unique URL. Each construction - and
            // each document running this engine - would get its own private
            // worker, so the worker "works" but is silently NOT shared across
            // tabs (Vite and Parcel both shipped this bug and reverted it; Vite
            // switched to data: URLs, which share but run on an opaque origin
            // where importScripts() - required by our bootstrap - fails).
            // Wrapping would break single-connection/single-state guarantees of
            // real apps, so SharedWorker construction is left fully native and
            // unwrapped. If worker-side hooks are ever needed for SharedWorker,
            // inject config through the first port message from the page-side
            // wrapper instead of a blob bootstrap.
            if (!isShared) {
              const res = wrapWorkerScript(scriptURL, options);
              wrappedURL = res.wrappedURL;
              isWrapped = res.isWrapped;
              newArgs = args.length > 0 ? [wrappedURL] : [];
              if (args.length > 1) newArgs.push(options);
            }

            let instance;
            try {
              instance = Reflect.construct(OrigWorker, newArgs, newTarget);
            } catch (err) {
              if (isWrapped && wrappedURL !== scriptURL) {
                instance = Reflect.construct(OrigWorker, args, newTarget);
              } else {
                throw err;
              }
            }

            return instance;
          }, name, OrigWorker.length, OrigWorker.prototype);

          try {
            Object.defineProperty(targetWin, name, {
              value: HookedWorker,
              writable: true,
              configurable: true,
              enumerable: false
            });
          } catch (_) {
            targetWin[name] = HookedWorker;
          }
        }
      });
    } catch (_) {}

    // Cross-instance completion mark (see getSharedPatchMarks): a fresh
    // non-registered Symbol plus a random value frozen onto targetWin, and the
    // { s, v } pair stored in the shared WeakMap. Recorded only after every
    // hook section above has run, so a mark always means "fully patched".
    // Every step is best-effort: a cross-origin window (or a frozen object)
    // makes defineProperty throw, which must never abort the patching that
    // already happened above.
    try {
      const sharedMarks = getSharedPatchMarks();
      const markSymbol = Symbol();
      const markValue = randomHex16();
      Object.defineProperty(targetWin, markSymbol, {
        value: markValue,
        enumerable: false,
        configurable: false,
        writable: false
      });
      sharedMarks.set(targetWin, { s: markSymbol, v: markValue });
    } catch (_) {}
  }

  // Initialize stealth on current window
  applyStealth(window);
})();
