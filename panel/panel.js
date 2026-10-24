'use strict';

// Shared regex for identifying CJK / domestic vendor fonts
const CHINESE_FONTS_REGEX = /(?:simsun|nsimsun|simhei|yahei|jhenghei|wenquanyi|pingfang|songti|kaiti|fangsong|dengxian|heiti|mingliu|pmingliu|st(?:heiti|kaiti|song|fangsong|xihei|zhongsong)|lisu|youyuan|biaukai|dfkai|source[ _-]?han|noto[ _-]?(?:sans|serif)?(?:[ _-]?mono)?[ _-]?(?:cjk|sc|tc|hk)|hiragino[ _-]?sans[ _-]?gb|misans|harmonyos|oppo|vivo|alipuhei|dingtalk|douyin|honor(?:[ _-]?sans)?|flyme|meizu|kingsoft|wps|micro[ _-]?hei|zen[ _-]?hei|fz[a-z0-9_-]*|founder|仓颉|华文|方正|汉仪|[\u4e00-\u9fa5])/i;

// Regex for identifying other non-Latin world scripts (Arabic, Hebrew, Indic, Thai, ancient scripts, etc.)
const OTHER_SCRIPTS_REGEX = /(?:arabic|kufi|naskh|nastaliq|urdu|hebrew|amiri|aldhabi|scheherazade|devanagari|bengali|gurmukhi|gujarati|oriya|tamil|telugu|kannada|malayalam|sinhala|tibetan|thai|lao|khmer|myanmar|javanese|sundanese|balinese|batak|tagalog|ethiopic|adlam|bamum|bassa|coptic|tifinagh|vai|cuneiform|hieroglyph|runic|cherokee|ogham|canadian[ _-]?aboriginal|linear[ _-]?[ab]|syriac|thaana|georgian|armenian|glagolitic|samaritan|shavian|brahmi|kharoshthi|sharada|chakma|cham|grantha|kaithi|dogra|khojki|khudawadi|lepcha|mahajani|mandaic|manichaean|marchen|gondi|medefaidrin|meetei|mende|meroitic|miao|modi|mongolian|newa|phaistos|rejang|saurashtra|siddham|sompeng|syloti|tagbanwa|tai[ _-]?(?:le|viet|tham)|takri|wancho|tirhuta|ugaritic|warang|zanabazar)/i;

// Regex for identifying symbol/dingbat fonts (independent category)
const SYMBOLS_REGEX = /(?:math|symbol|emoji|d050000l|z003|standard[ _-]?symbols|wingdings|webdings|dingbats?)/i;

// Must stay in sync with GENERIC_CSS_FAMILIES in content/stealth_engine.js:
// the engine always lets these through, so the panel must never report them as hidden.
const GENERIC_CSS_FAMILIES = new Set([
  'serif', 'sans-serif', 'monospace', 'cursive', 'fantasy', 'system-ui',
  'ui-sans-serif', 'ui-serif', 'ui-monospace', 'emoji', 'math', 'fangsong'
]);

// Public suffixes that must never become bypass entries: accepting one would
// turn the background-generated exclude pattern into "*://*.com/*" and disable
// injection on every site under that suffix.
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
const PUBLIC_SUFFIX_MULTI = new Set([
  'co.uk', 'org.uk', 'me.uk', 'ltd.uk', 'plc.uk', 'net.uk', 'ac.uk', 'gov.uk', 'nhs.uk', 'police.uk',
  'com.cn', 'net.cn', 'org.cn', 'gov.cn', 'edu.cn', 'ac.cn',
  'co.jp', 'ne.jp', 'or.jp', 'ac.jp', 'go.jp', 'ed.jp', 'gr.jp', 'lg.jp',
  'co.kr', 'or.kr', 'ne.kr', 're.kr', 'go.kr', 'ac.kr',
  'com.au', 'net.au', 'org.au', 'edu.au', 'gov.au', 'asn.au', 'id.au',
  'co.nz', 'net.nz', 'org.nz', 'govt.nz', 'ac.nz',
  'co.in', 'net.in', 'org.in', 'firm.in', 'gen.in', 'ind.in', 'gov.in', 'ac.in', 'edu.in',
  'co.za', 'net.za', 'org.za', 'gov.za', 'ac.za',
  'com.br', 'net.br', 'org.br', 'gov.br', 'edu.br',
  'com.tw', 'net.tw', 'org.tw', 'idv.tw', 'gov.tw', 'edu.tw',
  'com.hk', 'net.hk', 'org.hk', 'gov.hk', 'edu.hk', 'idv.hk',
  'com.sg', 'net.sg', 'org.sg', 'gov.sg', 'edu.sg',
  'com.mx', 'net.mx', 'org.mx', 'gob.mx', 'edu.mx',
  'com.ar', 'net.ar', 'org.ar', 'gob.ar', 'edu.ar',
  'com.tr', 'net.tr', 'org.tr', 'gov.tr', 'edu.tr',
  'com.ru', 'net.ru', 'org.ru', 'pp.ru',
  'com.ua', 'net.ua', 'org.ua', 'gov.ua', 'edu.ua',
  'co.il', 'org.il', 'net.il', 'ac.il', 'gov.il',
  'com.my', 'net.my', 'org.my', 'gov.my', 'edu.my',
  'com.ph', 'net.ph', 'org.ph', 'gov.ph', 'edu.ph',
  'co.th', 'in.th', 'or.th', 'ac.th', 'go.th', 'net.th',
  'com.vn', 'net.vn', 'org.vn', 'gov.vn', 'edu.vn',
  'co.id', 'net.id', 'or.id', 'web.id', 'ac.id', 'go.id', 'sch.id',
  'com.co', 'net.co', 'org.co', 'gov.co', 'edu.co',
  'com.pe', 'net.pe', 'org.pe', 'gob.pe', 'edu.pe',
  'com.ng', 'net.ng', 'org.ng', 'gov.ng', 'edu.ng',
  'github.io', 'pages.dev', 'workers.dev', 'vercel.app', 'netlify.app', 'herokuapp.com',
  'blogspot.com', 'appspot.com', 'firebaseapp.com', 'web.app', 'onrender.com', 'fly.dev',
  'glitch.me', 'repl.co', 'replit.app', 'surge.sh', 'ngrok.io', 'ngrok-free.app',
  'trycloudflare.com', 'azurewebsites.net', 'cloudfront.net', 's3.amazonaws.com',
  'wordpress.com', 'tumblr.com', 'wixsite.com', 'weebly.com', 'notion.site', 'gitlab.io'
]);

// DOM Elements
const $modeControl = document.getElementById('modeControl');
const $searchInput = document.getElementById('searchInput');
const $langSelect = document.getElementById('langSelect');
const $langSelectMenu = document.getElementById('langSelectMenu');
const $langSelectSummary = document.getElementById('langSelectSummary');
const $fontCount = document.getElementById('fontCount');
const $headerToggle = document.getElementById('headerToggle');
const $iconToggle = document.getElementById('iconToggle');
const $headerName = document.getElementById('headerName');
const $iconName = document.getElementById('iconName');
const $fontRows = document.getElementById('fontRows');
const $globalShieldEnabled = document.getElementById('globalShieldEnabled');
const $barVis = document.getElementById('barVis');
const $barHid = document.getElementById('barHid');
const $nVis = document.getElementById('nVis');
const $nHid = document.getElementById('nHid');
const $selectAllBox = document.getElementById('selectAllBox');
const $selCount = document.getElementById('selCount');
const $btnSelectAll = document.getElementById('btnSelectAll');
const $btnInvert = document.getElementById('btnInvert');
const $btnHideSel = document.getElementById('btnHideSel');
const $btnShowSel = document.getElementById('btnShowSel');
const $btnResetDefaults = document.getElementById('btnResetDefaults');
const $bypassInput = document.getElementById('bypassInput');
const $bypassAdd = document.getElementById('bypassAdd');
const $bypassList = document.getElementById('bypassList');
const $bypassStatus = document.getElementById('bypassStatus');
const $exportSettings = document.getElementById('exportSettings');
const $importSettings = document.getElementById('importSettings');
const $importSettingsFile = document.getElementById('importSettingsFile');
const $backupStatus = document.getElementById('backupStatus');
const $settingsErrorBanner = document.getElementById('settingsErrorBanner');
const $settingsErrorText = document.getElementById('settingsErrorText');
const $settingsRetry = document.getElementById('settingsRetry');

// 眼睛图标:可见=睁眼,隐藏=眼斜杠,无需读表头即可理解
const EYE_ON = '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 12s3.5-6.5 10-6.5S22 12 22 12s-3.5 6.5-10 6.5S2 12 2 12z"/><circle cx="12" cy="12" r="2.6"/></svg>';
const EYE_OFF = '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 12s3.5-6.5 10-6.5S22 12 22 12s-3.5 6.5-10 6.5S2 12 2 12z"/><path d="M4 4l16 16"/></svg>';

// Language coverage generated from fontconfig into panel/font-language-coverage.json.
// It powers the multi-select language font selection helper.
const FONT_LANGUAGE_NAMES = {
  'zh-Hans': '简体中文', 'zh-Hant': '繁体中文', en: '英文', ja: '日文',
  ko: '韩文', fr: '法文', pt: '葡萄牙文', ar: '阿拉伯文',
  fa: '波斯文', ur: '乌尔都文', he: '希伯来文'
};

// State
let allFonts = [];
let customHiddenFonts = [];
let customAllowedFonts = [];
let blockBuiltinChineseFonts = false;
let blockOtherScripts = false;
let blockSymbols = false;
let fontMode = 'blacklist'; // 'blacklist' | 'whitelist'
let searchQuery = '';
let fontLanguageCoverage = null;
const fontIdsByName = new Map();
let globalShieldEnabled = true; // 与 popup 共用的全局开关(chrome.storage.local.globalShieldEnabled)
let selectedFonts = new Set(); // 选择集:仅用于批量操作,与每行的隐藏/可见状态互相独立
let bypassSites = [];
let settingsLoaded = false; // 初始 storage 读取完成前,禁止任何写入
let settingsLoadFailed = false;
const MAX_BYPASS_SITES = 500;
const MAX_FONT_LIST_ITEMS = 2000;
const MAX_FONT_ENTRY_LENGTH = 200;
let currentProcessedFonts = []; // 最近一次渲染的列表,供就地更新复用

document.body.classList.add('settings-loading');

function showSettingsLoadError(detail) {
  settingsLoadFailed = true;
  settingsLoaded = false;
  document.body.classList.remove('settings-loading');
  document.body.classList.add('settings-error');
  document.querySelector('.settings-body')?.setAttribute('inert', '');
  document.querySelector('.masthead-actions')?.setAttribute('inert', '');
  if ($globalShieldEnabled) $globalShieldEnabled.disabled = true;
  if ($btnResetDefaults) $btnResetDefaults.disabled = true;
  if ($fontCount) $fontCount.textContent = '读取设置失败';
  if ($fontRows) $fontRows.innerHTML = '<div class="no-result">无法读取扩展设置，请刷新页面重试。</div>';
  if ($settingsErrorBanner) $settingsErrorBanner.hidden = false;
  if ($settingsErrorText) {
    $settingsErrorText.textContent = detail || '当前页面不会保存任何修改。请检查扩展状态后刷新重试。';
  }
}

if ($settingsRetry) {
  $settingsRetry.addEventListener('click', () => location.reload());
}


// Sorting State
let sortField = 'none'; // 'none' | 'toggle' | 'name'
let sortOrder = 'default';

function getFontCategory(name) {
  if (CHINESE_FONTS_REGEX.test(name)) return 'cjk';
  if (SYMBOLS_REGEX.test(name)) return 'symbol';
  if (OTHER_SCRIPTS_REGEX.test(name)) return 'other';
  return 'latin';
}

function isGenericCssFamily(name) {
  return GENERIC_CSS_FAMILIES.has(String(name || '').trim().toLowerCase());
}

function normalizeFontKey(value) {
  return String(value || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '');
}

function isTypingTarget(target) {
  if (!target || typeof target !== 'object') return false;
  const tag = target.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  return target.isContentEditable === true;
}

function sameStringArray(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function normalizeStoredFontList(value) {
  return Array.isArray(value) ? value.filter(item => typeof item === 'string') : [];
}

function fontEntryEquals(entry, lowerName) {
  return typeof entry === 'string' && entry.trim().toLowerCase() === lowerName;
}

// 导入时使用:去重、过滤空值/超长项,并限制数量。
function sanitizeFontList(value) {
  if (!Array.isArray(value)) return [];
  const result = [];
  const seen = new Set();
  for (const item of value) {
    if (typeof item !== 'string') continue;
    const trimmed = item.trim();
    if (!trimmed || item.length > MAX_FONT_ENTRY_LENGTH) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(trimmed);
    if (result.length >= MAX_FONT_LIST_ITEMS) break;
  }
  return result;
}

function getFontLanguages(name) {
  if (!fontLanguageCoverage) return [];
  const id = fontIdsByName.get(name);
  for (const value of [id, name]) {
    const raw = String(value || '').trim().toLowerCase();
    if (raw && Array.isArray(fontLanguageCoverage[raw])) return fontLanguageCoverage[raw];
    const key = normalizeFontKey(value);
    if (!key) continue;
    const languages = fontLanguageCoverage[key];
    if (Array.isArray(languages)) return languages;
  }
  return [];
}

let languageCountCache = null;

async function loadFontLanguageCoverage() {
  try {
    const url = chrome.runtime && chrome.runtime.getURL
      ? chrome.runtime.getURL('panel/font-language-coverage.json')
      : 'panel/font-language-coverage.json';
    const res = await fetch(url);
    if (res.ok) {
      fontLanguageCoverage = await res.json();
      languageCountCache = null;
      updateLanguageSelectionMenu();
    }
  } catch (_) {}
}

function getLanguageCounts() {
  if (languageCountCache) return languageCountCache;
  const counts = Object.create(null);
  for (const code of Object.keys(FONT_LANGUAGE_NAMES)) counts[code] = 0;
  for (const name of allFonts) {
    for (const code of getFontLanguages(name)) {
      if (Object.prototype.hasOwnProperty.call(counts, code)) counts[code] += 1;
    }
  }
  languageCountCache = counts;
  return counts;
}

function updateLanguageSelectionMenu() {
  if (!$langSelectMenu) return;
  const checked = [...$langSelectMenu.querySelectorAll('input[data-lang]:checked')].length;
  if ($langSelectSummary) $langSelectSummary.textContent = checked ? `${checked} 种` : '多选';
  const counts = getLanguageCounts();
  $langSelectMenu.querySelectorAll('input[data-lang]').forEach(cb => {
    const code = cb.dataset.lang;
    const name = FONT_LANGUAGE_NAMES[code] || code;
    const count = fontLanguageCoverage ? (counts[code] || 0) : 0;
    const countEl = cb.closest('.lang-pref-option')?.querySelector('.lang-select-count');
    if (countEl) countEl.textContent = count ? String(count) : '';
    cb.disabled = !fontLanguageCoverage || count === 0;
    cb.title = !fontLanguageCoverage
      ? '语言覆盖数据未加载'
      : count
        ? `支持${name}的字体（${count} 款）`
        : `未收录${name}字体`;
  });
}

function applyLanguageSelection() {
  if (!$langSelectMenu) return;
  const checked = [...$langSelectMenu.querySelectorAll('input[data-lang]:checked')].map(cb => cb.dataset.lang);
  const matched = new Set();
  if (checked.length) {
    for (const f of allFonts) {
      if (getFontLanguages(f).some(code => checked.includes(code))) matched.add(f);
    }
  }
  selectedFonts = matched;
  refreshAllRowSelection();
  updateSelectionUI();
}

function clearLanguageChecks() {
  if (!$langSelectMenu) return;
  $langSelectMenu.querySelectorAll('input[data-lang]').forEach(cb => { cb.checked = false; });
  updateLanguageSelectionMenu();
}

function isFontChecked(name) {
  const lower = name.toLowerCase();
  if (fontMode === 'blacklist') {
    // 黑名单模式：勾选 = 加入黑名单（隐藏，字体仍正常渲染）
    if (isGenericCssFamily(name)) return false;
    if (customAllowedFonts.some(f => fontEntryEquals(f, lower))) {
      return false;
    }
    if (customHiddenFonts.some(r => {
      if (typeof r !== 'string') return false;
      const s = r.trim();
      if (!s) return false;
      if (s.startsWith('/') && s.length > 2 && s.endsWith('/')) {
        try { return new RegExp(s.slice(1, -1), 'i').test(name); } catch (_) {}
      }
      // 与引擎的精确匹配语义保持一致,不做子串匹配
      return lower === s.toLowerCase();
    })) {
      return true;
    }
    if (blockBuiltinChineseFonts && CHINESE_FONTS_REGEX.test(name)) return true;
    if (blockOtherScripts && OTHER_SCRIPTS_REGEX.test(name)) return true;
    if (blockSymbols && SYMBOLS_REGEX.test(name)) return true;
    return false;
  } else {
    // 白名单模式：勾选 = 加入白名单（仅放行勾选字体，不被隐藏）；通用族始终可见
    if (isGenericCssFamily(name)) return true;
    return customAllowedFonts.some(f => fontEntryEquals(f, lower));
  }
}

function isFontHidden(name) {
  // 引擎对通用 CSS 族始终放行（见 GENERIC_CSS_FAMILIES），面板不得显示为已隐藏。
  if (isGenericCssFamily(name)) return false;
  if (fontMode === 'blacklist') {
    return isFontChecked(name);
  } else {
    // 白名单模式下只有勾选的字体不被隐藏
    return !isFontChecked(name);
  }
}

function saveState() {
  // 初始 storage 尚未读回时,绝不写入,避免用默认值覆盖已有规则
  if (!settingsLoaded || settingsLoadFailed) return;
  chrome.storage.local.set({
    fontMode,
    customHiddenFonts,
    customAllowedFonts,
    blockBuiltinChineseFonts,
    blockOtherScripts,
    blockSymbols
  });
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function getProcessedFonts() {
  let list = allFonts.slice();

  // 1. Search Filter (supports font name & category keywords)
  if (searchQuery) {
    list = list.filter(f => {
      const lower = f.toLowerCase();
      if (lower.includes(searchQuery)) return true;
      const cat = getFontCategory(f);
      if (searchQuery === '中文' && cat === 'cjk') return true;
      if (searchQuery === '西文' && cat === 'latin') return true;
      if ((searchQuery === '其他' || searchQuery === '其他语种' || searchQuery === '多语种' || searchQuery === '小语种' || searchQuery === '其他文字' || searchQuery === '冷门') && cat === 'other') return true;
      if ((searchQuery === '符号' || searchQuery === 'symbol' || searchQuery === 'symbols') && cat === 'symbol') return true;
      return false;
    });
  }

  // 2. Sort
  list.sort((a, b) => {
    if (sortField === 'toggle') {
      const aChecked = isFontChecked(a) ? 1 : 0;
      const bChecked = isFontChecked(b) ? 1 : 0;
      if (sortOrder === 'checked-first') {
        if (aChecked !== bChecked) return bChecked - aChecked;
      } else if (sortOrder === 'unchecked-first') {
        if (aChecked !== bChecked) return aChecked - bChecked;
      }
      return a.localeCompare(b);
    }

    if (sortField === 'name') {
      if (sortOrder === 'desc') {
        return b.localeCompare(a);
      }
      return a.localeCompare(b);
    }

    // Default: name A-Z
    return a.localeCompare(b);
  });

  return list;
}

// 表头排序状态:资源管理器式纯箭头(↕ 未排序 / ↑↓ 方向),并维护 aria-sort 供屏幕阅读器播报
function updateSortHeaders() {
  if ($headerToggle && $iconToggle) {
    if (sortField === 'toggle') {
      $iconToggle.textContent = sortOrder === 'checked-first' ? '↑' : '↓';
      $headerToggle.classList.add('active');
      // 可见性两态没有天然的"升/降"方向,这里按约定:隐藏优先=ascending
      $headerToggle.setAttribute('aria-sort', sortOrder === 'checked-first' ? 'ascending' : 'descending');
    } else {
      $iconToggle.textContent = '↕';
      $headerToggle.classList.remove('active');
      $headerToggle.setAttribute('aria-sort', 'none');
    }
  }

  if ($headerName && $iconName) {
    if (sortField === 'name') {
      $iconName.textContent = sortOrder === 'asc' ? '↑' : '↓';
      $headerName.classList.add('active');
      $headerName.setAttribute('aria-sort', sortOrder === 'asc' ? 'ascending' : 'descending');
    } else {
      $iconName.textContent = '↕';
      $headerName.classList.remove('active');
      $headerName.setAttribute('aria-sort', 'none');
    }
  }

}

function isFontProtectionOn() {
  const input = moduleInputs['fontProtection'];
  return input ? input.checked : true;
}

function isFontEngineActive() {
  return settingsLoaded && globalShieldEnabled && isFontProtectionOn();
}

function updateEngineClasses() {
  document.body.classList.toggle('off', !globalShieldEnabled);
  document.body.classList.toggle('font-off', globalShieldEnabled && !isFontProtectionOn());
}

function fontEyeTooltip(hidden) {
  if (!globalShieldEnabled) return '全局防护已关闭：当前没有任何字体被隐藏';
  if (!isFontProtectionOn()) return '字体指纹防护已关闭：当前没有任何字体被隐藏';
  return hidden ? '已隐藏，点击恢复可见' : '网站可见，点击隐藏';
}

// 比例条与计数:全库可见/隐藏统计(引擎未激活时一切都是"可见"的诚实呈现)
function updateFontStats(matchCount) {
  const engineActive = isFontEngineActive();
  const nHid = engineActive ? allFonts.filter(f => isFontHidden(f)).length : 0;
  const nVis = allFonts.length - nHid;
  if ($nVis && $nHid && $barVis && $barHid) {
    $nVis.textContent = nVis;
    $nHid.textContent = nHid;
    const tot = allFonts.length || 1;
    $barVis.style.width = (nVis / tot * 100) + '%';
    $barHid.style.width = (nHid / tot * 100) + '%';
  }
  if ($fontCount) {
    if (searchQuery) {
      $fontCount.textContent = `匹配 ${matchCount} / ${allFonts.length} 款`;
    } else {
      $fontCount.textContent = `共 ${allFonts.length} 款字体`;
    }
  }
}

function updateRowElement(row, fontName) {
  const active = isFontEngineActive();
  const hidden = active && isFontHidden(fontName);
  const selected = selectedFonts.has(fontName);
  const tooltip = fontEyeTooltip(hidden);
  row.classList.toggle('is-hidden', hidden);
  row.classList.toggle('selected', selected);
  row.setAttribute('aria-label', `${fontName}，${hidden ? '已对网站隐藏' : '网站可见'}${selected ? '，已选中' : ''}，点击选择`);
  const eye = row.querySelector('.eye');
  if (eye) {
    eye.innerHTML = hidden ? EYE_OFF : EYE_ON;
    eye.title = tooltip;
    eye.setAttribute('aria-label', tooltip);
  }
  const cb = row.querySelector('.row-select');
  if (cb) cb.checked = selected;
}

function refreshRowsInPlace(fontNames) {
  const target = fontNames instanceof Set ? fontNames : new Set(fontNames);
  for (const row of $fontRows.querySelectorAll('.font-row')) {
    if (!target.has(row.dataset.font)) continue;
    updateRowElement(row, row.dataset.font);
  }
}

function refreshAllRowSelection() {
  for (const row of $fontRows.querySelectorAll('.font-row')) {
    const selected = selectedFonts.has(row.dataset.font);
    row.classList.toggle('selected', selected);
    const cb = row.querySelector('.row-select');
    if (cb) cb.checked = selected;
  }
}

function renderList(providedList) {
  if (!settingsLoaded) return;
  updateSortHeaders();
  updateEngineClasses();

  // Update font mode UI (点阵按钮的 active 态即当前模式). Scope this to the
  // font control: module mode buttons reuse .mode-btn and have their own state.
  if ($modeControl) {
    $modeControl.querySelectorAll('.mode-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.mode === fontMode);
    });
  }

  const list = Array.isArray(providedList) ? providedList : getProcessedFonts();
  currentProcessedFonts = list;
  updateFontStats(list.length);

  if (list.length === 0) {
    $fontRows.innerHTML = `<div class="no-result">${searchQuery ? '未找到匹配的字体' : '未检索到已安装字体'}</div>`;
    updateSelectionUI(list);
    updateLanguageSelectionMenu();
    return;
  }

  const engineActive = isFontEngineActive();
  $fontRows.innerHTML = list.map(f => {
    const hidden = engineActive && isFontHidden(f);
    const selected = selectedFonts.has(f);
    const eyeTooltip = fontEyeTooltip(hidden);

    const rowAria = `${f}，${hidden ? '已对网站隐藏' : '网站可见'}${selected ? '，已选中' : ''}，点击选择`;

    return `
      <div class="font-row ${hidden ? 'is-hidden' : ''} ${selected ? 'selected' : ''}" data-font="${escapeHtml(f)}" role="button" tabindex="0" aria-label="${rowAria}">
        <div class="col-select">
          <input type="checkbox" class="row-select" data-font="${escapeHtml(f)}" ${selected ? 'checked' : ''} aria-label="选择 ${escapeHtml(f)}">
        </div>
        <button type="button" class="eye" data-font="${escapeHtml(f)}" title="${eyeTooltip}" aria-label="${eyeTooltip}"${engineActive ? '' : ' disabled'}>${hidden ? EYE_OFF : EYE_ON}</button>
        <div class="col-name">
          <span class="font-title" style="font-family: '${escapeHtml(f)}', sans-serif;">${escapeHtml(f)}</span>
        </div>
      </div>
    `;
  }).join('');

  updateSelectionUI(list);
  updateLanguageSelectionMenu();
}

// 选择集 UI:计数、批量按钮可用性、表头全选/半选
function updateSelectionUI(list = currentProcessedFonts) {
  const n = selectedFonts.size;
  if ($selCount) $selCount.textContent = n ? `已选 ${n} 项` : '未选择';
  const engineActive = isFontEngineActive();
  const actionsDisabled = n === 0 || !engineActive;
  if ($btnHideSel) $btnHideSel.disabled = actionsDisabled;
  if ($btnShowSel) $btnShowSel.disabled = actionsDisabled;

  if ($selectAllBox) {
    const selCount = list.filter(f => selectedFonts.has(f)).length;
    $selectAllBox.disabled = list.length === 0 || !engineActive;
    $selectAllBox.checked = list.length > 0 && selCount === list.length;
    $selectAllBox.indeterminate = selCount > 0 && selCount < list.length;
  }
}

// 选择(不改变可见状态)
function toggleSelection(fontName) {
  if (!fontName) return;
  clearLanguageChecks();
  if (selectedFonts.has(fontName)) selectedFonts.delete(fontName);
  else selectedFonts.add(fontName);
  // 就地更新,不重绘列表,保住键盘焦点
  const row = [...$fontRows.querySelectorAll('.font-row')].find(r => r.dataset.font === fontName);
  if (row) {
    const cb = row.querySelector('.row-select');
    const selected = selectedFonts.has(fontName);
    row.classList.toggle('selected', selected);
    if (cb) cb.checked = selected;
  }
  updateSelectionUI();
}

function selectAllFiltered() {
  clearLanguageChecks();
  const list = getProcessedFonts();
  currentProcessedFonts = list;
  for (const f of list) selectedFonts.add(f);
  refreshAllRowSelection();
  updateSelectionUI(list);
}

function invertFiltered() {
  clearLanguageChecks();
  const list = getProcessedFonts();
  currentProcessedFonts = list;
  for (const f of list) {
    if (selectedFonts.has(f)) selectedFonts.delete(f);
    else selectedFonts.add(f);
  }
  refreshAllRowSelection();
  updateSelectionUI(list);
}

function clearSelection() {
  clearLanguageChecks();
  selectedFonts = new Set();
  refreshAllRowSelection();
  updateSelectionUI();
}

// Search input: 防抖,避免每个按键都全量过滤+排序
let searchRenderTimer = null;
if ($searchInput) {
  $searchInput.addEventListener('input', () => {
    searchQuery = $searchInput.value.trim().toLowerCase();
    clearTimeout(searchRenderTimer);
    searchRenderTimer = setTimeout(() => {
      searchRenderTimer = null;
      renderList();
    }, 100);
  });
}

// Multi-select languages: checking a language selects every font supporting it.
if ($langSelectMenu) {
  $langSelectMenu.addEventListener('change', (e) => {
    if (e.target.closest('input[data-lang]')) applyLanguageSelection();
  });
}

document.addEventListener('click', (e) => {
  if ($langSelect && $langSelect.open && !e.target.closest('.lang-pref')) {
    $langSelect.open = false;
  }
});

// Mode selector click
if ($modeControl) {
  $modeControl.addEventListener('click', (e) => {
    if (!settingsLoaded) return;
    const btn = e.target.closest('.mode-btn');
    if (!btn) return;
    const targetMode = btn.dataset.mode;
    if (!targetMode || targetMode === fontMode) return;

    fontMode = targetMode;
    if (fontMode === 'whitelist' && customAllowedFonts.length === 0) {
      customAllowedFonts = allFonts.filter(f => !CHINESE_FONTS_REGEX.test(f));
    }
    // 模式语义翻转后旧选择不再有意义,清空避免批量操作误伤
    selectedFonts = new Set();
    clearLanguageChecks();
    saveState();
    renderList();
  });
}

// Header sorting: Toggle
if ($headerToggle) {
  $headerToggle.addEventListener('click', () => {
    if (sortField !== 'toggle') {
      sortField = 'toggle';
      sortOrder = 'checked-first';
    } else if (sortOrder === 'checked-first') {
      sortOrder = 'unchecked-first';
    } else {
      sortField = 'none';
      sortOrder = 'default';
    }
    renderList();
  });
}

// Header sorting: Name
if ($headerName) {
  $headerName.addEventListener('click', () => {
    if (sortField !== 'name') {
      sortField = 'name';
      sortOrder = 'asc';
    } else if (sortOrder === 'asc') {
      sortOrder = 'desc';
    } else {
      sortField = 'name';
      sortOrder = 'asc';
    }
    renderList();
  });
}

// 表头键盘操作:Enter/Space 触发与点击相同的排序
document.querySelector('.cols').addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' && e.key !== ' ') return;
  const col = e.target.closest('.sortable');
  if (!col) return;
  e.preventDefault();
  col.click();
});

// 设置单个字体的真实可见状态(黑/白名单模式各自映射回原有存储语义)
function setFontHidden(fontName, hidden) {
  // 通用族不受配置影响，绝不写入隐藏/放行列表。
  if (!fontName || isGenericCssFamily(fontName)) return;
  const lower = fontName.toLowerCase();
  if (fontMode === 'blacklist') {
    if (hidden) {
      // 加入黑名单(隐藏)
      if (!customHiddenFonts.some(f => fontEntryEquals(f, lower))) {
        customHiddenFonts.push(fontName);
      }
      customAllowedFonts = customAllowedFonts.filter(f => !fontEntryEquals(f, lower));
    } else {
      // 移出黑名单(可见);正则/内建/符号规则若仍命中,用 allowed 显式放行
      customHiddenFonts = customHiddenFonts.filter(f => !fontEntryEquals(f, lower));
      if (isFontHidden(fontName)) {
        if (!customAllowedFonts.some(f => fontEntryEquals(f, lower))) {
          customAllowedFonts.push(fontName);
        }
      }
    }
  } else {
    // 白名单模式: allowed 列表 = 可见集合;只移除/添加当前字体,绝不动其他条目
    if (hidden) {
      customAllowedFonts = customAllowedFonts.filter(f => !fontEntryEquals(f, lower));
    } else {
      if (!customAllowedFonts.some(f => fontEntryEquals(f, lower))) {
        customAllowedFonts.push(fontName);
      }
    }
  }
}

// 单行眼睛:直接翻转可见状态
function toggleFont(fontName) {
  if (!fontName || !isFontEngineActive()) return; // 全局/字体防护关闭时不改配置,只读
  setFontHidden(fontName, !isFontHidden(fontName));
  saveState();
  if (sortField === 'toggle') {
    renderList();
    return;
  }
  refreshRowsInPlace([fontName]);
  updateFontStats(currentProcessedFonts.length);
  updateSelectionUI();
}

// 批量:隐藏/显示所选
function applyToSelection(hidden) {
  if (!isFontEngineActive() || selectedFonts.size === 0) return;
  const affected = [...selectedFonts];
  for (const fontName of affected) {
    setFontHidden(fontName, hidden);
  }
  saveState();
  if (sortField === 'toggle') {
    renderList();
    return;
  }
  refreshRowsInPlace(affected);
  updateFontStats(currentProcessedFonts.length);
  updateSelectionUI();
}

// 行内交互:眼睛=翻状态,其余区域=选择;复选框走 change
$fontRows.addEventListener('click', (e) => {
  if (e.target.closest('.row-select')) return; // 复选框由 change 处理
  const row = e.target.closest('.font-row');
  if (!row) return;
  if (e.target.closest('.eye')) toggleFont(row.dataset.font);
  else toggleSelection(row.dataset.font);
});

$fontRows.addEventListener('change', (e) => {
  const cb = e.target.closest('.row-select');
  if (!cb) return;
  toggleSelection(cb.dataset.font);
});

$fontRows.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' && e.key !== ' ') return;
  if (e.target.closest('.eye, .row-select')) return; // 按钮/复选框自己处理按键
  const row = e.target.closest('.font-row');
  if (!row) return;
  e.preventDefault();
  toggleSelection(row.dataset.font);
});

// 选择操作条
if ($btnSelectAll) $btnSelectAll.addEventListener('click', selectAllFiltered);
if ($btnInvert) $btnInvert.addEventListener('click', invertFiltered);
if ($btnHideSel) $btnHideSel.addEventListener('click', () => applyToSelection(true));
if ($btnShowSel) $btnShowSel.addEventListener('click', () => applyToSelection(false));
if ($selectAllBox) {
  $selectAllBox.addEventListener('change', () => {
    if ($selectAllBox.checked) selectAllFiltered();
    else clearSelection();
  });
}

// '/' 聚焦当前视图的搜索框;输入控件聚焦时不抢字符(例如在例外输入框里输入 https://)
document.addEventListener('keydown', (e) => {
  if (e.key !== '/' || e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return;
  if (isTypingTarget(e.target)) return;
  const fontsView = document.getElementById('view-fonts');
  if (!fontsView || fontsView.hidden || !$searchInput) return;
  e.preventDefault();
  $searchInput.focus();
});

// 恢复扩展全局默认设置:保护模块、字体、时区、位置、语言回到默认。
// 保留主题、站点旁路名单、IP 缓存等用户数据。
function restoreDefaults() {
  const defaults = {
    globalShieldEnabled: true,
    fontMode: 'blacklist',
    customHiddenFonts: [],
    customAllowedFonts: [],
    blockBuiltinChineseFonts: false,
    blockOtherScripts: false,
    blockSymbols: false,
    fontProtection: true,
    canvasProtection: true,
    webrtcProtection: true,
    audioProtection: true,
    timezoneProtection: true,
    geolocationProtection: false,
    hardwareProtection: true,
    languageProtection: false,
    timezoneMode: 'auto',
    languageTarget: 'en-US'
  };
  for (const key of MODULE_OPTION_KEYS) defaults[key] = true;
  for (const key of DEFAULT_OFF_OPTION_KEYS) defaults[key] = false;
  chrome.storage.local.set(defaults, () => {
    chrome.storage.local.remove([
      'manualTimezone', 'geoTimezone', 'targetTimezone',
      'geolocationLatitude', 'geolocationLongitude', 'fontLanguages'
    ], () => location.reload());
  });
}

// 恢复默认按钮:两步确认,防误触清空配置
let resetConfirmTimer = null;
function resetButtonIdle() {
  if (!$btnResetDefaults) return;
  $btnResetDefaults.classList.remove('confirm');
  $btnResetDefaults.innerHTML = '<span aria-hidden="true">↺</span> 恢复默认';
}
if ($btnResetDefaults) {
  $btnResetDefaults.addEventListener('click', () => {
    if (!settingsLoaded) return;
    if (!$btnResetDefaults.classList.contains('confirm')) {
      $btnResetDefaults.classList.add('confirm');
      $btnResetDefaults.textContent = '确认恢复？';
      clearTimeout(resetConfirmTimer);
      resetConfirmTimer = setTimeout(resetButtonIdle, 3000);
      return;
    }
    clearTimeout(resetConfirmTimer);
    resetButtonIdle();
    restoreDefaults();
  });
}

// 全局总开关:与 popup 共用 chrome.storage.local.globalShieldEnabled
function applyShieldState(enabled) {
  globalShieldEnabled = !!enabled;
  updateEngineClasses();
  if ($globalShieldEnabled) {
    $globalShieldEnabled.checked = globalShieldEnabled;
  }
  updateLanguagePreview();
}

if ($globalShieldEnabled) {
  $globalShieldEnabled.addEventListener('change', () => {
    if (!settingsLoaded) {
      $globalShieldEnabled.checked = globalShieldEnabled;
      return;
    }
    globalShieldEnabled = $globalShieldEnabled.checked;
    chrome.storage.local.set({ globalShieldEnabled });
    applyShieldState(globalShieldEnabled);
    renderList();
  });
}


// ── 站点旁路管理 ──
function isValidIpv6Host(host) {
  try {
    return new URL('http://' + host).hostname === host;
  } catch (_) {
    return false;
  }
}

function isPublicSuffixHost(host) {
  const value = String(host || '').trim().toLowerCase();
  if (!value || value === 'localhost') return false;
  if (value.startsWith('[') || value.includes(':')) return false;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(value)) return false;
  if (PUBLIC_SUFFIX_MULTI.has(value)) return true;
  if (value.includes('.')) return false;
  // 所有两字母标签都是 ccTLD；其余单标签只拒绝已知 gTLD，
  // 保留 localhost 与普通内网主机名。
  return PUBLIC_SUFFIX_SINGLE.has(value) || /^[a-z]{2}$/.test(value);
}

function parseBypassSite(raw) {
  let value = String(raw || '').trim().toLowerCase();
  if (!value) return { site: '', reason: 'empty' };
  if (/^[a-z][a-z0-9+.-]*:\/\//.test(value)) {
    value = value.replace(/^[a-z][a-z0-9+.-]*:\/\//, '').split(/[/?#]/)[0];
    const at = value.lastIndexOf('@');
    if (at >= 0) value = value.slice(at + 1);
  }
  value = value.replace(/^\*\.?/, '').replace(/^\.+/, '');
  if (value.startsWith('[')) {
    const end = value.indexOf(']');
    if (end < 0) return { site: '', reason: 'invalid' };
    const host = value.slice(0, end + 1);
    return /^\[[0-9a-f:.]+\]$/.test(host) && host.includes(':') && isValidIpv6Host(host)
      ? { site: host, reason: '' }
      : { site: '', reason: 'invalid' };
  }
  value = value.split('/')[0].split(':')[0];
  if (!value) return { site: '', reason: 'invalid' };
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(value)) {
    return value.split('.').every(part => Number(part) <= 255)
      ? { site: value, reason: '' }
      : { site: '', reason: 'invalid' };
  }
  const valid = /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(value);
  if (!valid) return { site: '', reason: 'invalid' };
  if (isPublicSuffixHost(value)) return { site: '', reason: 'public-suffix' };
  return { site: value, reason: '' };
}

function normalizeBypassSite(raw) {
  return parseBypassSite(raw).site;
}

function setBypassStatus(message, isError = false) {
  if (!$bypassStatus) return;
  $bypassStatus.textContent = message || '';
  $bypassStatus.classList.toggle('error', isError);
}

function renderBypassList() {
  if (!$bypassList) return;
  const sites = [...new Set(bypassSites.map(normalizeBypassSite).filter(Boolean))].sort((a, b) => a.localeCompare(b));
  $bypassList.replaceChildren();
  $bypassList.hidden = sites.length === 0;
  for (const site of sites) {
    const row = document.createElement('div');
    row.className = 'opt-row opt-row-select';
    const copy = document.createElement('span');
    copy.className = 'opt-copy';
    const name = document.createElement('span');
    name.className = 'opt-title bypass-domain';
    name.textContent = site;
    copy.appendChild(name);
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'sel-btn';
    remove.textContent = '移除';
    remove.setAttribute('aria-label', `移除例外网站 ${site}`);
    remove.addEventListener('click', () => removeBypassSite(site));
    row.append(copy, remove);
    $bypassList.appendChild(row);
  }
}

function saveBypassList(message) {
  chrome.storage.local.set({ siteBypassList: bypassSites }, () => {
    if (chrome.runtime.lastError) {
      setBypassStatus('保存失败，请重试。', true);
      return;
    }
    renderBypassList();
    setBypassStatus(message || '');
  });
}

function addBypassSite() {
  if (!$bypassInput) return;
  if (!settingsLoaded) {
    setBypassStatus('设置仍在加载，请稍候。', true);
    return;
  }
  const parsedBypass = parseBypassSite($bypassInput.value);
  if (!parsedBypass.site) {
    setBypassStatus(
      parsedBypass.reason === 'public-suffix'
        ? '不能加入公共后缀（如 com、co.uk、com.cn），请输入完整域名，例如 example.com。'
        : '请输入有效的域名或网址，例如 example.com。',
      true
    );
    $bypassInput.focus();
    return;
  }
  const site = parsedBypass.site;
  if (bypassSites.includes(site)) {
    setBypassStatus('该网站已在例外名单中。', true);
    return;
  }
  if (bypassSites.length >= MAX_BYPASS_SITES) {
    setBypassStatus(`例外名单最多 ${MAX_BYPASS_SITES} 个网站，请先移除部分条目。`, true);
    return;
  }
  bypassSites = [...bypassSites, site].sort((a, b) => a.localeCompare(b));
  $bypassInput.value = '';
  saveBypassList(`已加入例外：${site}`);
}

function removeBypassSite(site) {
  if (!settingsLoaded) return;
  bypassSites = bypassSites.filter(item => item !== site);
  saveBypassList(`已移除例外：${site}`);
}

if ($bypassAdd) $bypassAdd.addEventListener('click', addBypassSite);
if ($bypassInput) {
  $bypassInput.addEventListener('keydown', event => {
    if (event.key === 'Enter') {
      event.preventDefault();
      addBypassSite();
    }
  });
}

// Cross-tab / storage sync
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  // 初始读取完成前的变更由初始快照覆盖,不在这里重绘/回写
  if (!settingsLoaded) return;
  let changed = false;
  if (changes.fontMode) {
    const next = changes.fontMode.newValue === 'whitelist' ? 'whitelist' : 'blacklist';
    if (next !== fontMode) { fontMode = next; changed = true; }
  }
  if (changes.customHiddenFonts) {
    const next = normalizeStoredFontList(changes.customHiddenFonts.newValue);
    if (!sameStringArray(customHiddenFonts, next)) { customHiddenFonts = next; changed = true; }
  }
  if (changes.customAllowedFonts) {
    const next = normalizeStoredFontList(changes.customAllowedFonts.newValue);
    if (!sameStringArray(customAllowedFonts, next)) { customAllowedFonts = next; changed = true; }
  }
  if (changes.blockBuiltinChineseFonts) {
    const next = changes.blockBuiltinChineseFonts.newValue === true;
    if (next !== blockBuiltinChineseFonts) { blockBuiltinChineseFonts = next; changed = true; }
  }
  if (changes.blockOtherScripts) {
    const next = changes.blockOtherScripts.newValue === true;
    if (next !== blockOtherScripts) { blockOtherScripts = next; changed = true; }
  }
  if (changes.blockSymbols) {
    const next = changes.blockSymbols.newValue === true;
    if (next !== blockSymbols) { blockSymbols = next; changed = true; }
  }
  if (changes.globalShieldEnabled) {
    const next = changes.globalShieldEnabled.newValue !== false;
    if (next !== globalShieldEnabled) {
      applyShieldState(next);
      changed = true;
    }
  }
  // 模块开关跨上下文同步(popup ↔ 设置页)
  let moduleChanged = false;
  let fontEngineChanged = false;
  for (const key of MODULE_KEYS) {
    if (!changes[key]) continue;
    const val = changes[key].newValue !== false;
    const input = moduleInputs[key];
    const wasChecked = input ? input.checked : undefined;
    if (input && wasChecked !== val) input.checked = val;
    if (key === 'fontProtection' && wasChecked !== val) fontEngineChanged = true;
    if (wasChecked !== val) moduleChanged = true;
  }
  if (moduleChanged) {
    syncModuleUi();
    renderConsole();
  }
  if (changes.timezone || changes.targetTimezone || changes.timezoneMode || changes.manualTimezone || changes.geoTimezone) {
    storageGet(['timezone', 'targetTimezone', 'timezoneMode', 'manualTimezone', 'geoTimezone'])
      .then(applyTzUI)
      .catch(() => {});
  }
  if (changes.geolocationLatitude || changes.geolocationLongitude) {
    storageGet(['geolocationLatitude', 'geolocationLongitude'])
      .then(applyGeoUI)
      .catch(() => {});
  }
  if (changes.ipLatitude || changes.ipLongitude || changes.ipCity) {
    storageGet(['ipLatitude', 'ipLongitude', 'ipCity'])
      .then(applyIpUI)
      .catch(() => {});
  }
  if (changes.languageTarget && $languageTarget) {
    $languageTarget.value = normalizeLanguageTarget(changes.languageTarget.newValue);
    updateLanguagePreview();
  }
  for (const key of MODULE_OPTION_KEYS) {
    if (changes[key]) updateModuleOptionUI(key, changes[key].newValue);
  }
  if (changes.theme) {
    applyTheme(changes.theme.newValue);
  }
  if (changes.siteBypassList) {
    const rawList = Array.isArray(changes.siteBypassList.newValue) ? changes.siteBypassList.newValue : [];
    const cleaned = sanitizeBypassSites(rawList);
    bypassSites = cleaned;
    renderBypassList();
    if (!sameStringArray(rawList, cleaned)) {
      chrome.storage.local.set({ siteBypassList: cleaned }, () => { void chrome.runtime.lastError; });
    }
  }
  if (changed || fontEngineChanged) renderList();
});

// ── 设置页:模块开关 / 侧栏导航 / 时区信息 ──
const MODULE_KEYS = ['canvasProtection', 'webrtcProtection', 'audioProtection', 'timezoneProtection', 'geolocationProtection', 'hardwareProtection', 'fontProtection', 'languageProtection'];
const moduleInputs = {};
for (const key of MODULE_KEYS) {
  const el = document.getElementById(key);
  if (el) moduleInputs[key] = el;
}

function syncModuleUi() {
  updateLanguagePreview();
}

for (const [key, el] of Object.entries(moduleInputs)) {
  el.addEventListener('change', () => {
    if (!settingsLoaded) return;
    chrome.storage.local.set({ [key]: el.checked });
    onModuleToggle(key, el.checked);
    if (key === 'fontProtection') renderList();
  });
}

const MODULE_OPTION_KEYS = [
  'canvas2dExport', 'canvas2dPixels', 'canvasWebglExport',
  'audioGetChannelData', 'audioCopyFromChannel',
  'hardwareGpu', 'hardwareScreen', 'hardwareTimer', 'hardwareGamepad',
  'webrtcBlockSupport', 'webrtcBlockDevices', 'webrtcBlockObjects',
  'webrtcDevices', 'webrtcLocalIp', 'webrtcUdp',
  'languageNavigator', 'languageIntl', 'languageHeader'
];
const DEFAULT_OFF_OPTION_KEYS = new Set(['webrtcBlockSupport', 'webrtcBlockDevices', 'webrtcBlockObjects', 'webrtcUdp', 'hardwareGamepad']);

const SETTINGS_EXPORT_KEYS = [
  'globalShieldEnabled', ...MODULE_KEYS, ...MODULE_OPTION_KEYS,
  'fontMode', 'customHiddenFonts', 'customAllowedFonts',
  'blockBuiltinChineseFonts', 'blockOtherScripts', 'blockSymbols',
  'languageTarget', 'timezoneMode', 'manualTimezone', 'geoTimezone', 'targetTimezone',
  'geolocationLatitude', 'geolocationLongitude', 'siteBypassList', 'theme'
];
const SETTINGS_BOOLEAN_KEYS = new Set([
  'globalShieldEnabled', ...MODULE_KEYS, ...MODULE_OPTION_KEYS,
  'blockBuiltinChineseFonts', 'blockOtherScripts', 'blockSymbols'
]);
const SETTINGS_STRING_KEYS = new Set([
  'fontMode', 'languageTarget', 'timezoneMode', 'manualTimezone',
  'geoTimezone', 'targetTimezone', 'theme'
]);
const SETTINGS_NUMBER_KEYS = new Set(['geolocationLatitude', 'geolocationLongitude']);

function storageGet(keys) {
  return new Promise((resolve, reject) => {
    chrome.storage.local.get(keys, (res) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message || 'storage read failed'));
        return;
      }
      resolve(res || {});
    });
  });
}

function setBackupStatus(message, isError = false) {
  if (!$backupStatus) return;
  $backupStatus.textContent = message || '';
  $backupStatus.classList.toggle('error', isError);
}

async function exportSettings() {
  try {
    const values = await storageGet(SETTINGS_EXPORT_KEYS);
    const payload = {
      format: 'bocchi-settings',
      version: 1,
      exportedAt: new Date().toISOString(),
      settings: values
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `bocchi-settings-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    setBackupStatus('设置已导出。');
  } catch (err) {
    console.error('Failed to export settings:', err);
    setBackupStatus('导出失败，请重试。', true);
  }
}

const ALLOWED_FONT_MODES = new Set(['blacklist', 'whitelist']);
const ALLOWED_TIMEZONE_MODES = new Set(['auto', 'geo', 'manual']);
const ALLOWED_THEMES = new Set(['system', 'dark', 'light']);

function sanitizeTimezone(value) {
  if (typeof value !== 'string') return null;
  const zone = value.trim();
  if (!zone || zone.length > 100) return null;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone }).format(new Date(0));
    return zone;
  } catch (_) {
    return null;
  }
}

function sanitizeLanguageTargetValue(value) {
  if (typeof value !== 'string' || !value) return null;
  if ($languageTarget) {
    return Array.from($languageTarget.options).some(o => o.value === value) ? value : null;
  }
  // 严格 BCP 47 结构(语言-脚本-地区-变体),避免写入任意字符串
  return /^[A-Za-z]{2,3}(?:-[A-Za-z]{4})?(?:-(?:[A-Za-z]{2}|\d{3}))?(?:-[A-Za-z0-9]{5,8})*$/.test(value) ? value : null;
}

function sanitizeCoordinate(key, value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  if (key === 'geolocationLatitude') return value >= -90 && value <= 90 ? value : null;
  return value >= -180 && value <= 180 ? value : null;
}

function sanitizeBypassSites(value) {
  const sites = [];
  const seen = new Set();
  for (const raw of value) {
    if (typeof raw !== 'string') continue;
    const site = normalizeBypassSite(raw);
    if (!site || seen.has(site)) continue;
    seen.add(site);
    sites.push(site);
    if (sites.length >= MAX_BYPASS_SITES) break;
  }
  return sites;
}

function sanitizeImportedSettings(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  if (data.settings !== undefined &&
      (data.settings === null || typeof data.settings !== 'object' || Array.isArray(data.settings))) {
    return null;
  }
  const source = data.settings && typeof data.settings === 'object' ? data.settings : data;
  const result = {};
  const dropped = new Set();
  const rejectedPublicSuffixes = new Set();
  for (const key of SETTINGS_EXPORT_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(source, key)) continue;
    const value = source[key];
    let accepted = false;

    if (SETTINGS_BOOLEAN_KEYS.has(key)) {
      if (typeof value === 'boolean') { result[key] = value; accepted = true; }
    } else if (key === 'fontMode') {
      if (ALLOWED_FONT_MODES.has(value)) { result[key] = value; accepted = true; }
    } else if (key === 'timezoneMode') {
      if (ALLOWED_TIMEZONE_MODES.has(value)) { result[key] = value; accepted = true; }
    } else if (key === 'theme') {
      if (ALLOWED_THEMES.has(value)) { result[key] = value; accepted = true; }
    } else if (key === 'languageTarget') {
      const target = sanitizeLanguageTargetValue(value);
      if (target) { result[key] = target; accepted = true; }
    } else if (key === 'manualTimezone' || key === 'geoTimezone' || key === 'targetTimezone') {
      const zone = sanitizeTimezone(value);
      if (zone) { result[key] = zone; accepted = true; }
    } else if (SETTINGS_NUMBER_KEYS.has(key)) {
      const coordinate = sanitizeCoordinate(key, value);
      if (coordinate !== null) { result[key] = coordinate; accepted = true; }
    } else if (key === 'customHiddenFonts' || key === 'customAllowedFonts') {
      if (Array.isArray(value)) {
        result[key] = sanitizeFontList(value);
        if (result[key].length !== value.length) dropped.add(key);
        accepted = true;
      }
    } else if (key === 'siteBypassList') {
      if (Array.isArray(value)) {
        for (const raw of value) {
          if (typeof raw !== 'string') continue;
          if (parseBypassSite(raw).reason === 'public-suffix') {
            rejectedPublicSuffixes.add(raw.trim());
          }
        }
        result[key] = sanitizeBypassSites(value);
        if (result[key].length !== value.length) dropped.add(key);
        accepted = true;
      }
    } else if (SETTINGS_STRING_KEYS.has(key) && typeof value === 'string') {
      result[key] = value;
      accepted = true;
    }

    if (!accepted) dropped.add(key);
  }
  return Object.keys(result).length
    ? { settings: result, dropped: [...dropped], rejectedPublicSuffixes: [...rejectedPublicSuffixes] }
    : null;
}

async function importSettings(file) {
  if (!file) return;
  try {
    if (file.size > 1024 * 1024) {
      setBackupStatus('文件过大，设置备份应小于 1 MB。', true);
      return;
    }
    const parsed = JSON.parse(await file.text());
    const sanitized = sanitizeImportedSettings(parsed);
    if (!sanitized) {
      setBackupStatus('没有找到可导入的有效 Bocchi 设置。', true);
      return;
    }
    if (!window.confirm('导入会覆盖当前防护设置和网站例外名单，是否继续？')) return;
    chrome.storage.local.set(sanitized.settings, () => {
      if (chrome.runtime.lastError) {
        setBackupStatus('导入失败，请重试。', true);
        return;
      }
      const notes = [];
      if (sanitized.rejectedPublicSuffixes.length) {
        const preview = sanitized.rejectedPublicSuffixes.slice(0, 3).join('、');
        notes.push(`已拒绝公共后缀 ${preview}${sanitized.rejectedPublicSuffixes.length > 3 ? ' 等' : ''}`);
      }
      if (sanitized.dropped.length) {
        notes.push(`已忽略 ${sanitized.dropped.length} 项无效设置`);
      }
      const ignored = notes.length ? `（${notes.join('；')}）` : '';
      setBackupStatus(`设置已导入${ignored}，正在刷新…`);
      setTimeout(() => location.reload(), 350);
    });
  } catch (err) {
    console.error('Failed to import settings:', err);
    setBackupStatus('无法读取该文件，请选择有效的 JSON 设置备份。', true);
  }
}

if ($exportSettings) $exportSettings.addEventListener('click', exportSettings);
if ($importSettings && $importSettingsFile) {
  $importSettings.addEventListener('click', () => $importSettingsFile.click());
  $importSettingsFile.addEventListener('change', () => {
    const file = $importSettingsFile.files && $importSettingsFile.files[0];
    importSettings(file).finally(() => { $importSettingsFile.value = ''; });
  });
}


function updateModuleOptionUI(key, value) {
  const el = document.getElementById(key);
  if (el) el.checked = value !== false;
  updateLanguagePreview();
}

function setupModuleOptions() {
  for (const key of MODULE_OPTION_KEYS) {
    const el = document.getElementById(key);
    if (!el) continue;
    el.addEventListener('change', () => {
      if (!settingsLoaded) return;
      chrome.storage.local.set({ [key]: el.checked });
      updateLanguagePreview();
    });
  }
}

setupModuleOptions();

// 视图路由:侧栏切换 + hash 深链(默认字体)
function showView(name) {
  if (name === 'geolocation') name = 'timezone'; // 合并后的旧深链兼容
  let found = false;
  document.querySelectorAll('.view').forEach(v => {
    const match = v.dataset.view === name;
    v.hidden = !match;
    if (match) found = true;
  });
  if (!found) name = 'canvas';
  document.querySelectorAll('.nav-item').forEach(b => {
    b.setAttribute('aria-current', b.dataset.view === name ? 'page' : 'false');
  });
  if (location.hash !== '#' + name) history.replaceState(null, '', '#' + name);
}

document.querySelectorAll('.nav-item').forEach(btn => {
  btn.addEventListener('click', () => showView(btn.dataset.view));
});
window.addEventListener('hashchange', () => {
  if (location.hash === '#settings-content') {
    document.getElementById('settings-content')?.focus();
    return;
  }
  showView((location.hash || '#canvas').slice(1));
});

// 时区 / 位置控制台:地图是唯一交互面,两个眼睛是信号层
const GEO_DEFAULT = { lat: 34.0522, lng: -118.2437 };
let geoLat = GEO_DEFAULT.lat;
let geoLng = GEO_DEFAULT.lng;
let ipLat = NaN;
let ipLng = NaN;
let ipCity = '';
let tzMode = 'auto';          // auto(出口 IP) | geo(跟随位置) | manual
let tzManual = '';
let tzGeo = '';
let autoTzValue = '';
let hostTz = 'UTC';
try { hostTz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch (_) {}
let dragging = false;
let dragMoved = false;
let lastDragEnd = 0;
let flightToken = 0;
let previewCity = null;
let lastClockText = '';
let clockInitialized = false;

let CITY_DATA = [];
let cityNameLanguage = 'system';
let onlineCityNames = {};
let onlineCityNamesLang = '';
let onlineNamesToken = 0;
let onlineNamesLoading = false;

async function loadCityData() {
  try {
    const url = (chrome.runtime && chrome.runtime.getURL)
      ? chrome.runtime.getURL('panel/city-names.json')
      : 'panel/city-names.json';
    const res = await fetch(url);
    if (!res.ok) return;
    const data = await res.json();
    if (Array.isArray(data)) {
      CITY_DATA = data
        .filter(c => c && typeof c.lat === 'number' && typeof c.lng === 'number' && c.tz)
        .sort((a, b) => (b.pop || 0) - (a.pop || 0));
    }
  } catch (_) {}
}

function resolveCityLocale() {
  let lang = cityNameLanguage;
  if (lang === 'system') {
    try {
      lang = (chrome.i18n && chrome.i18n.getUILanguage && chrome.i18n.getUILanguage()) || navigator.language || 'en';
    } catch (_) {
      lang = (navigator && navigator.language) || 'en';
    }
  }
  lang = String(lang || 'en');
  if (/^zh/i.test(lang)) return 'zh-CN';
  if (/^en/i.test(lang)) return 'en';
  return lang.split('-')[0].toLowerCase() || 'en';
}

function cityDisplayName(city) {
  if (!city) return '';
  const locale = resolveCityLocale();
  if (locale === 'zh-CN') return city.zh || city.en || '';
  if (locale === 'en') return city.en || city.zh || '';
  return onlineCityNames[city.en] || city.en || city.zh || '';
}

function citySecondaryName(city) {
  if (!city) return '';
  const locale = resolveCityLocale();
  if (locale === 'zh-CN') return city.en && city.en !== city.zh ? city.en : '';
  if (locale === 'en') return '';
  const local = onlineCityNames[city.en];
  return local && city.en && local !== city.en ? city.en : '';
}

function updateCityNameStatus(text) {
  const el = document.getElementById('cityNameStatus');
  if (el) el.textContent = text || '';
}

function renderAllNames() {
  renderConsole();
  if ($cityResults && !$cityResults.hidden && $citySearch) renderCityResults($citySearch.value);
}

function applyCityLanguage(value) {
  cityNameLanguage = value || 'system';
  const locale = resolveCityLocale();
  if (locale === 'zh-CN' || locale === 'en') {
    onlineNamesToken++;
    onlineCityNames = {};
    onlineCityNamesLang = locale;
    onlineNamesLoading = false;
    updateCityNameStatus('');
    renderAllNames();
    return;
  }
  if (onlineNamesLoading && onlineCityNamesLang === locale) {
    renderAllNames();
    return;
  }
  if (onlineCityNamesLang === locale && Object.keys(onlineCityNames).length) {
    renderAllNames();
    return;
  }
  loadOnlineCityNames(locale);
}

function loadOnlineCityNames(lang) {
  const token = ++onlineNamesToken;
  onlineCityNamesLang = lang;
  onlineNamesLoading = true;
  updateCityNameStatus('在线获取中…');
  chrome.storage.local.get(['cityNameCache'], (cached) => {
    if (token !== onlineNamesToken) return;
    if (chrome.runtime.lastError) {
      fetchOnlineCityNames(lang, token);
      return;
    }
    const cache = (cached && cached.cityNameCache) || {};
    if (cache[lang] && Object.keys(cache[lang]).length) {
      onlineCityNames = cache[lang];
      onlineNamesLoading = false;
      const unique = new Set(CITY_DATA.map(c => c.en).filter(Boolean));
      updateCityNameStatus(unique.size > Object.keys(onlineCityNames).length ? '部分回退英文' : '');
      renderAllNames();
      return;
    }
    fetchOnlineCityNames(lang, token);
  });
}

async function fetchOnlineCityNames(lang, token) {
  const names = [...new Set(CITY_DATA.map(c => c.en).filter(Boolean))];
  const result = {};
  let failed = false;
  for (let i = 0; i < names.length; i += 50) {
    if (token !== onlineNamesToken) return;
    const batch = names.slice(i, i + 50);
    const url = 'https://en.wikipedia.org/w/api.php?action=query&format=json&origin=*&prop=langlinks&redirects=1&lllimit=500&lllang=' +
      encodeURIComponent(lang) + '&titles=' + encodeURIComponent(batch.join('|'));
    try {
      const res = await fetch(url);
      if (!res.ok) { failed = true; continue; }
      const data = await res.json();
      if (!data.query || !data.query.pages) { failed = true; continue; }
      const alias = {};
      for (const n of (data.query && data.query.normalized) || []) alias[n.from] = n.to;
      for (const r of (data.query && data.query.redirects) || []) alias[r.from] = r.to;
      const byTitle = {};
      for (const p of Object.values((data.query && data.query.pages) || {})) {
        if (p && p.langlinks && p.langlinks[0] && p.langlinks[0]['*']) byTitle[p.title] = p.langlinks[0]['*'];
      }
      for (const name of batch) {
        const title = alias[name] || name;
        const local = byTitle[title];
        if (local) result[name] = local;
      }
    } catch (_) {
      failed = true;
    }
    await new Promise(r => setTimeout(r, 60));
  }
  if (token !== onlineNamesToken) return;
  onlineCityNames = result;
  onlineNamesLoading = false;
  const count = Object.keys(result).length;
  const missing = names.length - count;
  updateCityNameStatus(count === 0 ? '在线获取失败，已回退英文' : (missing > 0 || failed ? '部分回退英文' : ''));
  if (count) {
    chrome.storage.local.get(['cityNameCache'], (cached) => {
      if (chrome.runtime.lastError) return;
      const cache = (cached && cached.cityNameCache) || {};
      cache[lang] = result;
      chrome.storage.local.set({ cityNameCache: cache });
    });
  }
  renderAllNames();
}

const $worldMap = document.getElementById('worldMap');
const $worldPath = document.getElementById('worldPath');
const $pin = document.getElementById('tpPin');
const $ipMarker = document.getElementById('tpIpMarker');
const $ipArc = document.getElementById('tpIpArc');
const $ipTitle = document.getElementById('tpIpTitle');
const $flightTrail = document.getElementById('tpFlightTrail');
const $geoLat = document.getElementById('geoLat');
const $geoLng = document.getElementById('geoLng');
const $tzSelect = document.getElementById('tzSelect');
const $citySearch = document.getElementById('citySearch');
const $languageTarget = document.getElementById('languageTarget');

function normalizeLanguageTarget(value) {
  if ($languageTarget && Array.from($languageTarget.options).some(o => o.value === value)) return value;
  return 'en-US';
}

// 语言模块的当前生效结果:不打开 DevTools 也能确认三项信号是否一致
function setLanguageResult(id, value, native) {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = value;
  el.classList.toggle('is-native', native);
}

function updateLanguagePreview() {
  const stateEl = document.getElementById('languageResultState');
  if (!stateEl) return;
  const protection = document.getElementById('languageProtection');
  const targetSel = document.getElementById('languageTarget');
  let target = targetSel ? targetSel.value : 'en-US';
  if (!target || !targetSel || !Array.from(targetSel.options).some(o => o.value === target)) target = 'en-US';
  const nav = document.getElementById('languageNavigator');
  const intl = document.getElementById('languageIntl');
  const header = document.getElementById('languageHeader');
  const moduleOn = !!(protection && protection.checked);
  const active = globalShieldEnabled && moduleOn;
  const navOn = active && !!(nav && nav.checked);
  const intlOn = active && !!(intl && intl.checked);
  const headerOn = active && !!(header && header.checked);
  const base = target.split('-')[0];
  const headerValue = base && base !== target ? `${target},${base};q=0.9` : target;

  setLanguageResult('languageResultNavigator', navOn ? target : '原生', !navOn);
  setLanguageResult('languageResultIntl', intlOn ? target : '原生', !intlOn);
  setLanguageResult('languageResultHeader', headerOn ? headerValue : '原生', !headerOn);

  stateEl.textContent = !globalShieldEnabled ? '全局已暂停' : !moduleOn ? '未启用' : (navOn || intlOn || headerOn) ? '已生效' : '未生效';
  stateEl.classList.toggle('on', navOn || intlOn || headerOn);
}
const $cityResults = document.getElementById('cityResults');
const $cursorReadout = document.getElementById('cursorReadout');
const $coordsPop = document.getElementById('coordsPop');
const $tpClock = document.getElementById('tpClock');
const $tpDaynight = document.getElementById('tpDaynight');
const $tpZone = document.getElementById('tpZone');
const $tpOffset = document.getElementById('tpOffset');
const $tpTzOff = document.getElementById('tpTzOff');
const $tpHudZone = document.getElementById('tpHudZone');
const $tpCoordsText = document.getElementById('tpCoordsText');
const $tpCoordsOff = document.getElementById('tpCoordsOff');
const $tzMismatch = document.getElementById('tzMismatch');
const $tzNote = document.getElementById('tzNote');

function tzLayerOn() {
  return !!(moduleInputs['timezoneProtection'] && moduleInputs['timezoneProtection'].checked);
}
function geoLayerOn() {
  return !!(moduleInputs['geolocationProtection'] && moduleInputs['geolocationProtection'].checked);
}
function clampLat(v) { return Math.max(-90, Math.min(90, v)); }
function clampLng(v) { return Math.max(-180, Math.min(180, v)); }
function toXY(lat, lng) {
  return { x: (lng + 180) / 360 * 720, y: (90 - lat) / 180 * 360 };
}
function formatCoords(lat, lng) {
  return lat.toFixed(4) + ', ' + lng.toFixed(4);
}
const timeFmtCache = new Map();
const dateFmtCache = new Map();
const offsetFmtCache = new Map();
const hourFmtCache = new Map();
function formatter(cache, zone, opts) {
  let f = cache.get(zone);
  if (!f) {
    f = new Intl.DateTimeFormat(opts.locale, { timeZone: zone, ...opts.options });
    cache.set(zone, f);
  }
  return f;
}
function timeIn(zone) {
  try {
    return formatter(timeFmtCache, zone, { locale: 'en-GB', options: { hour: '2-digit', minute: '2-digit', hour12: false } }).format(new Date());
  } catch (_) { return '--:--'; }
}
function dateIn(zone) {
  try {
    const parts = formatter(dateFmtCache, zone, {
      locale: 'zh-CN',
      options: { year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short' }
    }).formatToParts(new Date());
    const part = type => (parts.find(p => p.type === type) || {}).value || '';
    return `${part('year')}-${part('month')}-${part('day')} ${part('weekday')}`.trim();
  } catch (_) { return ''; }
}
function tzOffsetLabel(zone) {
  try {
    const parts = formatter(offsetFmtCache, zone, { locale: 'en-US', options: { timeZoneName: 'shortOffset' } }).formatToParts(new Date());
    const off = parts.find(p => p.type === 'timeZoneName');
    return off ? off.value : '';
  } catch (_) { return ''; }
}
function zoneName(zone) {
  return String(zone || '').split('/').pop().replace(/_/g, ' ');
}
function nearestCity(lat, lng) {
  let best = null;
  let bestD = Infinity;
  const cosLat = Math.cos(lat * Math.PI / 180);
  for (const c of CITY_DATA) {
    const dLat = lat - c.lat;
    const dLng = (lng - c.lng) * cosLat;
    const d = dLat * dLat + dLng * dLng;
    if (d < bestD) { bestD = d; best = c; }
  }
  return best;
}
function nearestTz(lat, lng) {
  const c = nearestCity(lat, lng);
  return c ? c.tz : null;
}
function tzRepPoint(tz) {
  if (!tz) return null;
  const c = CITY_DATA.find(x => x.tz === tz);
  return c ? { lat: c.lat, lng: c.lng } : null;
}
function derivedZone() {
  return nearestTz(geoLat, geoLng);
}
function effectiveZone() {
  if (!tzLayerOn()) return hostTz;
  if (tzMode === 'manual') return tzManual || autoTzValue || hostTz;
  if (tzMode === 'geo') {
    if (!geoLayerOn()) return autoTzValue || hostTz;
    // 拖动时优先用当前坐标推导,让时钟跟手;存储值只作兜底
    return derivedZone() || tzGeo || autoTzValue || hostTz;
  }
  return autoTzValue || hostTz;
}
function solarDeclination(date) {
  const start = Date.UTC(date.getUTCFullYear(), 0, 0);
  const day = (date.getTime() - start) / 86400000;
  return 23.44 * Math.sin((2 * Math.PI / 365) * (day - 81));
}
function isDaylightAt(lat, lng) {
  const now = new Date();
  const decl = solarDeclination(now) * Math.PI / 180;
  const utcHours = now.getUTCHours() + now.getUTCMinutes() / 60;
  const H = ((utcHours + lng / 15 - 12) * 15) * Math.PI / 180;
  const latRad = lat * Math.PI / 180;
  return Math.sin(latRad) * Math.sin(decl) + Math.cos(latRad) * Math.cos(decl) * Math.cos(H) > 0;
}
function daylightForZone(zone) {
  const rep = tzRepPoint(zone);
  if (rep) return isDaylightAt(rep.lat, rep.lng);
  try {
    const h = Number(formatter(hourFmtCache, zone, { locale: 'en-GB', options: { hour: '2-digit', hour12: false } }).format(new Date()));
    return h >= 6 && h < 18;
  } catch (_) { return true; }
}
function setClock(text) {
  if (!$tpClock || text === lastClockText) return;
  lastClockText = text;
  $tpClock.textContent = text;
  const reduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (clockInitialized && !reduced && $tpClock.animate) {
    $tpClock.animate([
      { opacity: .35, transform: 'translateY(3px)' },
      { opacity: 1, transform: 'translateY(0)' }
    ], { duration: 170, easing: 'cubic-bezier(.2,.8,.2,1)' });
  }
  clockInitialized = true;
}

function populateTzSelect() {
  if (!$tzSelect || $tzSelect.options.length > 0) return;
  let zones = [];
  try { zones = Intl.supportedValuesOf('timeZone'); } catch (_) { zones = []; }
  if (!zones.length) {
    zones = ['UTC', 'America/Los_Angeles', 'America/New_York', 'Europe/London',
      'Europe/Berlin', 'Asia/Shanghai', 'Asia/Tokyo', 'Asia/Singapore', 'Australia/Sydney'];
  }
  if (!zones.includes('UTC')) zones.unshift('UTC');
  zones = [...zones].sort((a, b) => a.localeCompare(b));
  for (const z of zones) {
    const opt = document.createElement('option');
    opt.value = z;
    opt.textContent = z;
    $tzSelect.appendChild(opt);
  }
}

function applyTzUI(res) {
  const mode = res && res.timezoneMode;
  tzMode = mode === 'manual' ? 'manual' : (mode === 'geo' ? 'geo' : 'auto');
  tzManual = res && typeof res.manualTimezone === 'string' ? res.manualTimezone : '';
  tzGeo = res && typeof res.geoTimezone === 'string' ? res.geoTimezone : '';
  const autoTz = res && (res.timezone || res.targetTimezone);
  autoTzValue = autoTz || '';
  populateTzSelect();
  if ($tzSelect) {
    const fallback = autoTz || 'UTC';
    const value = tzManual || fallback;
    if (value && ![...$tzSelect.options].some(o => o.value === value)) {
      const opt = document.createElement('option');
      opt.value = value;
      opt.textContent = value;
      $tzSelect.appendChild(opt);
    }
    $tzSelect.value = value;
    $tzSelect.hidden = tzMode !== 'manual';
  }
  renderConsole();
}

function applyGeoUI(res) {
  if (dragging) return;
  const lat = res && typeof res.geolocationLatitude === 'number' && isFinite(res.geolocationLatitude)
    ? res.geolocationLatitude : GEO_DEFAULT.lat;
  const lng = res && typeof res.geolocationLongitude === 'number' && isFinite(res.geolocationLongitude)
    ? res.geolocationLongitude : GEO_DEFAULT.lng;
  geoLat = lat;
  geoLng = lng;
  if ($geoLat) $geoLat.value = lat;
  if ($geoLng) $geoLng.value = lng;
  renderConsole();
  refreshGeoTimezone();
}

function applyIpUI(res) {
  ipLat = res && typeof res.ipLatitude === 'number' && isFinite(res.ipLatitude) ? res.ipLatitude : NaN;
  ipLng = res && typeof res.ipLongitude === 'number' && isFinite(res.ipLongitude) ? res.ipLongitude : NaN;
  ipCity = res && typeof res.ipCity === 'string' ? res.ipCity : '';
  renderConsole();
}

function refreshGeoTimezone() {
  if (tzMode !== 'geo' || dragging) return;
  const derived = nearestTz(geoLat, geoLng);
  if (!derived || derived === tzGeo) return;
  tzGeo = derived;
  chrome.storage.local.set({ geoTimezone: derived });
  renderConsole();
}

function saveGeo() {
  if (!settingsLoaded) return;
  chrome.storage.local.set({ geolocationLatitude: geoLat, geolocationLongitude: geoLng });
}

function commitPin() {
  if (!settingsLoaded) return;
  saveGeo();
  if (tzMode === 'geo') {
    const derived = nearestTz(geoLat, geoLng);
    if (derived && derived !== tzGeo) {
      tzGeo = derived;
      chrome.storage.local.set({ geoTimezone: derived });
    }
  }
  renderConsole();
}

function drawArc(from, to) {
  if (!$ipArc) return;
  const a = toXY(from.lat, from.lng);
  const b = toXY(to.lat, to.lng);
  const mx = (a.x + b.x) / 2;
  const my = Math.max(64, Math.min(338, Math.min(a.y, b.y) - Math.abs(b.x - a.x) * .10));
  $ipArc.setAttribute('d', `M${a.x.toFixed(1)},${a.y.toFixed(1)} Q${mx.toFixed(1)},${my.toFixed(1)} ${b.x.toFixed(1)},${b.y.toFixed(1)}`);
  $ipArc.removeAttribute('hidden');
}

function renderConsole() {
  if (!$pin) return;
  const zone = effectiveZone();
  const derived = derivedZone();
  const tzOn = tzLayerOn();
  const geoOn = geoLayerOn();
  const fallbackName = zoneName(derived || zone);
  const place = previewCity || nearestCity(geoLat, geoLng) || { en: fallbackName, zh: fallbackName };
  const placeDisplay = cityDisplayName(place);
  const placeSecondary = citySecondaryName(place);
  const pinP = toXY(geoLat, geoLng);

  $pin.setAttribute('transform', `translate(${pinP.x.toFixed(2)} ${pinP.y.toFixed(2)})`);
  $pin.classList.toggle('ghost', !geoOn);
  $pin.setAttribute('aria-label', '拖动设置位置：' + placeDisplay + ' ' + formatCoords(geoLat, geoLng));
  const pinLabel = $pin.querySelector('.tp-pin-label');
  if (pinLabel) pinLabel.textContent = placeDisplay;

  // 虚线圆 = 当前出口 IP 的大致位置;定位点 = 伪装坐标。
  // 精确坐标缺失时,用出口 IP 的时区代表城市估算,保证这个参考始终可见。
  let ipRef = null;
  let ipExact = false;
  if (Number.isFinite(ipLat) && Number.isFinite(ipLng)) {
    ipRef = { lat: ipLat, lng: ipLng };
    ipExact = true;
  } else if (autoTzValue) {
    ipRef = tzRepPoint(autoTzValue);
  }
  if (ipRef) {
    const ipP = toXY(ipRef.lat, ipRef.lng);
    const near = Math.hypot(ipP.x - pinP.x, ipP.y - pinP.y) <= 8;
    // 定位点已经落在出口 IP 上时，不再叠加虚线圈、标签和连线。
    if (near) {
      $ipMarker.classList.add('off');
      $ipArc.setAttribute('hidden', '');
    } else {
      const ring = $ipMarker.querySelector('.tp-ip-ring');
      const label = $ipMarker.querySelector('.tp-ip-label');
      $ipMarker.classList.remove('off');
      $ipMarker.setAttribute('transform', `translate(${ipP.x.toFixed(2)} ${ipP.y.toFixed(2)})`);
      if (ring) ring.setAttribute('r', 7);
      if (label) {
        label.textContent = ipExact ? '出口 IP' : '出口 IP（估算）';
        label.setAttribute('y', -13);
      }
      if ($ipTitle) {
        $ipTitle.textContent = ipExact
          ? '当前出口 IP 的大致位置' + (ipCity ? '，' + ipCity : '') + `，${ipLat.toFixed(2)}, ${ipLng.toFixed(2)}`
          : '按出口 IP 的时区估算，' + autoTzValue;
      }
      drawArc({ lat: geoLat, lng: geoLng }, ipRef);
    }
  } else {
    $ipMarker.classList.add('off');
    $ipArc.setAttribute('hidden', '');
  }

  const placeName = document.getElementById('tpPlace');
  const placeEn = document.getElementById('tpPlaceEn');
  if (placeName) placeName.textContent = placeDisplay;
  if (placeEn) placeEn.textContent = placeSecondary ? `(${placeSecondary})` : '';
  setClock(timeIn(zone));
  const dateLine = document.getElementById('tpDate');
  if (dateLine) dateLine.textContent = dateIn(zone);
  if ($tpDaynight) $tpDaynight.classList.toggle('night', !daylightForZone(zone));
  if ($tpZone) $tpZone.textContent = zone;
  if ($tpOffset) $tpOffset.textContent = tzOffsetLabel(zone);
  if ($tpTzOff) $tpTzOff.hidden = tzOn;
  if ($tpHudZone) $tpHudZone.classList.toggle('off', !tzOn);
  if ($tpCoordsText) $tpCoordsText.textContent = formatCoords(geoLat, geoLng);
  if ($tpCoordsOff) $tpCoordsOff.hidden = geoOn;

  document.querySelectorAll('.tp-chip').forEach(chip => {
    const on = chip.dataset.tzSource === tzMode;
    chip.classList.toggle('active', on);
    chip.setAttribute('aria-pressed', on ? 'true' : 'false');
  });
  if ($tzSelect) $tzSelect.hidden = tzMode !== 'manual';

  const mismatch = tzOn && geoOn && tzMode !== 'geo' && !!derived && zone !== derived;
  if ($tzMismatch) $tzMismatch.hidden = !mismatch;

  // Normal mode is already legible from the active source chip; only surface exceptions.
  let note = '';
  if (!tzOn) note = '时区伪装已关闭，网站看到真实时区';
  else if (!geoOn && tzMode === 'geo') note = '位置伪装已关闭，时区回退到网络出口';
  if ($tzNote) $tzNote.textContent = note;
}

// 时区来源
function setTzSource(mode) {
  if (!settingsLoaded) return;
  if (mode === 'geo') {
    if (!geoLayerOn()) {
      const input = moduleInputs['geolocationProtection'];
      if (input) {
        input.checked = true;
        input.dispatchEvent(new Event('change', { bubbles: true }));
      }
    }
    const derived = nearestTz(geoLat, geoLng);
    const patch = { timezoneMode: 'geo' };
    if (derived) { patch.geoTimezone = derived; tzGeo = derived; }
    chrome.storage.local.set(patch);
    tzMode = 'geo';
  } else if (mode === 'manual') {
    if (!tzManual) {
      tzManual = effectiveZone() || 'UTC';
      chrome.storage.local.set({ timezoneMode: 'manual', manualTimezone: tzManual });
    } else {
      chrome.storage.local.set({ timezoneMode: 'manual' });
    }
    tzMode = 'manual';
  } else {
    chrome.storage.local.set({ timezoneMode: 'auto' });
    tzMode = 'auto';
  }
  renderConsole();
}

document.querySelectorAll('.tp-chip').forEach(chip => {
  chip.addEventListener('click', () => setTzSource(chip.dataset.tzSource));
});
if ($tzMismatch) $tzMismatch.addEventListener('click', () => setTzSource('geo'));
if ($tzSelect) {
  $tzSelect.addEventListener('change', () => {
    if (!settingsLoaded) return;
    chrome.storage.local.set({ manualTimezone: $tzSelect.value, timezoneMode: 'manual' });
  });
}

// 模块开关变化:开启位置伪装时,时区默认跟随位置(仅从自动切换)
function onModuleToggle(key, on) {
  syncModuleUi();
  if (key === 'geolocationProtection' && on && tzMode === 'auto') {
    const derived = nearestTz(geoLat, geoLng);
    const patch = { timezoneMode: 'geo' };
    if (derived) { patch.geoTimezone = derived; tzGeo = derived; }
    chrome.storage.local.set(patch);
    tzMode = 'geo';
  }
  renderConsole();
}

// 地图坐标
function eventLatLng(e) {
  if (!$worldMap) return null;
  const ctm = $worldMap.getScreenCTM();
  if (!ctm) return null;
  const pt = $worldMap.createSVGPoint();
  pt.x = e.clientX;
  pt.y = e.clientY;
  const loc = pt.matrixTransform(ctm.inverse());
  if (loc.x < 0 || loc.x > 720 || loc.y < 0 || loc.y > 360) return null;
  return { lat: 90 - (loc.y / 360) * 180, lng: (loc.x / 720) * 360 - 180 };
}
function setPin(lat, lng) {
  geoLat = clampLat(lat);
  geoLng = clampLng(lng);
  previewCity = null;
  renderConsole();
}

// 拖动定位点:实时预览,松手提交
if ($pin) {
  $pin.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    e.stopPropagation();
    flightToken++;
    if ($flightTrail) $flightTrail.classList.remove('on');
    dragging = true;
    dragMoved = false;
    previewCity = null;
    $pin.classList.add('dragging');
    if ($cursorReadout) $cursorReadout.style.display = 'none';
    try { $pin.setPointerCapture(e.pointerId); } catch (_) {}
  });
  $pin.addEventListener('keydown', (e) => {
    const step = e.shiftKey ? 5 : 1;
    let dLat = 0, dLng = 0;
    if (e.key === 'ArrowUp') dLat = step;
    else if (e.key === 'ArrowDown') dLat = -step;
    else if (e.key === 'ArrowLeft') dLng = -step;
    else if (e.key === 'ArrowRight') dLng = step;
    else return;
    e.preventDefault();
    setPin(geoLat + dLat, geoLng + dLng);
    commitPin();
  });
}
window.addEventListener('pointermove', (e) => {
  if (!dragging) return;
  const p = eventLatLng(e);
  if (!p) return;
  dragMoved = true;
  setPin(p.lat, p.lng);
});
function endDrag() {
  if (!dragging) return;
  dragging = false;
  lastDragEnd = Date.now();
  if ($pin) $pin.classList.remove('dragging');
  if (dragMoved) commitPin();
}
window.addEventListener('pointerup', endDrag);
window.addEventListener('pointercancel', endDrag);

if ($worldMap) {
  $worldMap.addEventListener('click', (e) => {
    if (Date.now() - lastDragEnd < 300) return;
    const p = eventLatLng(e);
    if (!p) return;
    flightToken++;
    previewCity = null;
    if ($flightTrail) $flightTrail.classList.remove('on');
    setPin(p.lat, p.lng);
    commitPin();
  });
  $worldMap.addEventListener('mousemove', (e) => {
    if (dragging || !$cursorReadout) return;
    const p = eventLatLng(e);
    if (!p) { $cursorReadout.style.display = 'none'; return; }
    const ns = p.lat >= 0 ? 'N' : 'S';
    const ew = p.lng >= 0 ? 'E' : 'W';
    $cursorReadout.textContent = `${Math.abs(p.lat).toFixed(2)}${ns}  ${Math.abs(p.lng).toFixed(2)}${ew}`;
    const rect = $worldMap.getBoundingClientRect();
    $cursorReadout.style.left = (e.clientX - rect.left) + 'px';
    $cursorReadout.style.top = (e.clientY - rect.top) + 'px';
    $cursorReadout.style.display = 'block';
  });
  $worldMap.addEventListener('mouseleave', () => {
    if ($cursorReadout) $cursorReadout.style.display = 'none';
  });
}

// 城市搜索 + 曲线飞行
function renderCityResults(query) {
  if (!$cityResults) return;
  const q = String(query || '').trim().toLowerCase();
  const matches = CITY_DATA.filter(c => {
    if (!q) return true;
    const online = onlineCityNames[c.en] || '';
    return (c.zh || '').toLowerCase().includes(q) ||
      (c.en || '').toLowerCase().includes(q) ||
      (c.tz || '').toLowerCase().includes(q) ||
      online.toLowerCase().includes(q);
  });
  if (!matches.length) {
    $cityResults.innerHTML = '<div class="tp-results-empty">没有匹配的城市</div>';
    $cityResults.hidden = false;
    return;
  }
  $cityResults.innerHTML = matches.map((c, i) => {
    const primary = cityDisplayName(c);
    const secondary = citySecondaryName(c);
    return `
    <button type="button" class="tp-result" data-index="${i}">
      <span class="tp-result-left"><span class="tp-result-zh">${primary}</span>${secondary ? `<span class="tp-result-en">${secondary}</span>` : ''}</span>
      <span class="tp-result-right"><span class="tp-result-zone">${c.tz}</span><span class="tp-result-time">${timeIn(c.tz)}</span></span>
    </button>`;
  }).join('');
  $cityResults.hidden = false;
  $cityResults.querySelectorAll('.tp-result').forEach(btn => {
    btn.addEventListener('click', () => {
      const c = matches[Number(btn.dataset.index)];
      if (c) selectCity(c);
    });
  });
}

function selectCity(city) {
  if (!settingsLoaded) return;
  if ($citySearch) $citySearch.value = '';
  if ($cityResults) $cityResults.hidden = true;
  if (!geoLayerOn()) {
    const input = moduleInputs['geolocationProtection'];
    if (input) {
      input.checked = true;
      input.dispatchEvent(new Event('change', { bubbles: true }));
    }
  }
  if (tzMode === 'auto') {
    const derived = nearestTz(city.lat, city.lng);
    const patch = { timezoneMode: 'geo' };
    if (derived) { patch.geoTimezone = derived; tzGeo = derived; }
    chrome.storage.local.set(patch);
    tzMode = 'geo';
  }
  flyTo(city.lat, city.lng, city);
}

function flyTo(lat, lng, city) {
  const token = ++flightToken;
  previewCity = city;
  const reduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (reduced) {
    geoLat = lat; geoLng = lng;
    previewCity = null;
    commitPin();
    return;
  }
  const p0 = toXY(geoLat, geoLng);
  const p1 = toXY(lat, lng);
  const cx = (p0.x + p1.x) / 2;
  const cy = Math.max(18, Math.min(p0.y, p1.y) - Math.min(130, Math.abs(p1.x - p0.x) * .22 + 18));
  if ($flightTrail) {
    $flightTrail.setAttribute('d', `M${p0.x.toFixed(1)},${p0.y.toFixed(1)} Q${cx.toFixed(1)},${cy.toFixed(1)} ${p1.x.toFixed(1)},${p1.y.toFixed(1)}`);
    $flightTrail.classList.add('on');
  }
  const t0 = performance.now();
  const dur = 620;
  const ease = (t) => t < .5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
  function step(now) {
    if (token !== flightToken) return;
    const t = Math.min(1, (now - t0) / dur);
    const k = ease(t);
    const x = (1 - k) * (1 - k) * p0.x + 2 * (1 - k) * k * cx + k * k * p1.x;
    const y = (1 - k) * (1 - k) * p0.y + 2 * (1 - k) * k * cy + k * k * p1.y;
    geoLat = 90 - (y / 360) * 180;
    geoLng = (x / 720) * 360 - 180;
    renderConsole();
    if (t < 1) requestAnimationFrame(step);
    else {
      geoLat = lat; geoLng = lng;
      previewCity = null;
      commitPin();
      if ($flightTrail) $flightTrail.classList.remove('on');
    }
  }
  requestAnimationFrame(step);
}

if ($citySearch) {
  $citySearch.addEventListener('focus', () => renderCityResults($citySearch.value));
  $citySearch.addEventListener('input', () => renderCityResults($citySearch.value));
  $citySearch.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      $cityResults.hidden = true;
      $citySearch.blur();
    }
    if (e.key === 'Enter') {
      const first = $cityResults && !$cityResults.hidden ? $cityResults.querySelector('.tp-result') : null;
      if (first) first.click();
    }
  });
}
document.addEventListener('keydown', (e) => {
  if (e.key !== '/' || e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return;
  if (isTypingTarget(e.target)) return;
  const tzView = document.getElementById('view-timezone');
  if (!tzView || tzView.hidden || !$citySearch) return;
  e.preventDefault();
  $citySearch.focus();
});
document.addEventListener('click', (e) => {
  if ($cityResults && !$cityResults.hidden && !e.target.closest('.tp-search-wrap')) {
    $cityResults.hidden = true;
  }
});

// 精确坐标
const $tpCoords = document.getElementById('tpCoords');
const $coordsApply = document.getElementById('coordsApply');
const $coordsClose = document.getElementById('coordsClose');
function applyCoordsInputs() {
  if (!settingsLoaded) return;
  const lat = parseFloat($geoLat && $geoLat.value);
  const lng = parseFloat($geoLng && $geoLng.value);
  if (!isFinite(lat) || !isFinite(lng)) return;
  geoLat = clampLat(lat);
  geoLng = clampLng(lng);
  flightToken++;
  previewCity = null;
  if ($flightTrail) $flightTrail.classList.remove('on');
  renderConsole();
  commitPin();
  if ($coordsPop) $coordsPop.hidden = true;
}
if ($tpCoords) {
  $tpCoords.addEventListener('click', () => {
    if (!$coordsPop) return;
    $coordsPop.hidden = !$coordsPop.hidden;
    if (!$coordsPop.hidden) {
      if ($geoLat) { $geoLat.value = geoLat; $geoLat.focus(); }
      if ($geoLng) $geoLng.value = geoLng;
    }
  });
}
if ($coordsApply) $coordsApply.addEventListener('click', applyCoordsInputs);
if ($coordsClose) $coordsClose.addEventListener('click', () => { if ($coordsPop) $coordsPop.hidden = true; });
[$geoLat, $geoLng].forEach(el => {
  if (!el) return;
  el.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); applyCoordsInputs(); }
    if (e.key === 'Escape') { if ($coordsPop) $coordsPop.hidden = true; }
  });
});

// 首次开启位置伪装时,若从未设置过坐标,种入默认坐标,避免 0,0
const $geoProtection = document.getElementById('geolocationProtection');
if ($geoProtection) {
  $geoProtection.addEventListener('change', () => {
    if (!settingsLoaded || !$geoProtection.checked) return;
    chrome.storage.local.get(['geolocationLatitude', 'geolocationLongitude'], (r) => {
      if (chrome.runtime.lastError) return;
      if (typeof r.geolocationLatitude !== 'number' || typeof r.geolocationLongitude !== 'number') {
        chrome.storage.local.set({ geolocationLatitude: geoLat, geolocationLongitude: geoLng });
      }
    });
  });
}

// 地图底图 / 经纬网
if ($worldPath && window.BOCCHI_WORLD_MAP_PATH) {
  $worldPath.setAttribute('d', window.BOCCHI_WORLD_MAP_PATH);
}
(function buildGraticule() {
  const g = document.getElementById('tpGraticule');
  if (!g) return;
  const NS = 'http://www.w3.org/2000/svg';
  for (let x = 60; x < 720; x += 60) {
    const line = document.createElementNS(NS, 'line');
    line.setAttribute('x1', x); line.setAttribute('x2', x);
    line.setAttribute('y1', 0); line.setAttribute('y2', 360);
    g.appendChild(line);
  }
  for (let y = 60; y < 360; y += 60) {
    const line = document.createElementNS(NS, 'line');
    line.setAttribute('x1', 0); line.setAttribute('x2', 720);
    line.setAttribute('y1', y); line.setAttribute('y2', y);
    g.appendChild(line);
  }
})();

// 昼夜状态只用于 HUD 的太阳/月亮图标,地图不再绘制晨昏线

setInterval(() => { renderConsole(); }, 15000);

// 主题:右上角图标循环切换 跟随系统 → 深色 → 浅色(存储键 theme,默认 system)
const themeMedia = window.matchMedia('(prefers-color-scheme: light)');
const $themeToggle = document.getElementById('themeToggle');
let themePref = 'system';

const THEME_ICONS = {
  system: '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8"/><path d="M12 16v4"/></svg>',
  dark: '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>',
  light: '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>'
};
const THEME_LABELS = { system: '跟随系统', dark: '深色', light: '浅色' };
const THEME_CYCLE = ['system', 'dark', 'light'];

function resolvedTheme(pref) {
  if (pref === 'light') return 'light';
  if (pref === 'dark') return 'dark';
  return themeMedia.matches ? 'light' : 'dark';
}

function applyTheme(pref) {
  themePref = ['dark', 'light', 'system'].includes(pref) ? pref : 'system';
  document.documentElement.dataset.theme = resolvedTheme(themePref);
  if ($themeToggle) {
    $themeToggle.innerHTML = THEME_ICONS[themePref];
    const label = `主题：${THEME_LABELS[themePref]}（点击切换）`;
    $themeToggle.title = label;
    $themeToggle.setAttribute('aria-label', label);
  }
}

if ($themeToggle) {
  $themeToggle.addEventListener('click', () => {
    if (!settingsLoaded) return;
    const next = THEME_CYCLE[(THEME_CYCLE.indexOf(themePref) + 1) % THEME_CYCLE.length];
    chrome.storage.local.set({ theme: next });
    applyTheme(next);
  });
}

// 系统配色变化时,跟随模式实时切换
themeMedia.addEventListener('change', () => {
  if (themePref === 'system') applyTheme('system');
});

// Initialize
async function init() {
  try {
    await loadCityData();
    await loadFontLanguageCoverage();
    try {
      if (chrome.fontSettings && chrome.fontSettings.getFontList) {
        const list = await chrome.fontSettings.getFontList();
        const records = list
          .map(f => ({ name: f.displayName || f.fontId, id: f.fontId }))
          .filter(r => r.name);
        allFonts = records.map(r => r.name);
        fontIdsByName.clear();
        for (const record of records) fontIdsByName.set(record.name, record.id);
      }
    } catch (err) {
      console.error('Failed to get fonts via chrome.fontSettings:', err);
    }

    if (!allFonts || allFonts.length === 0) {
      allFonts = [
        'Arial', 'Arimo', 'Courier New', 'DejaVu Sans', 'DejaVu Serif', 'Liberation Mono',
        'Liberation Sans', 'Liberation Serif', 'Microsoft YaHei', 'Noto Sans CJK SC',
        'Noto Serif CJK SC', 'Noto Sans Arabic', 'PingFang SC', 'SimSun', 'SimHei', 'WenQuanYi Micro Hei'
      ];
    }

    allFonts.sort((a, b) => a.localeCompare(b));
    languageCountCache = null;

    chrome.storage.local.get(['customHiddenFonts', 'customAllowedFonts', 'blockBuiltinChineseFonts', 'blockOtherScripts', 'blockSymbols', 'fontMode', 'globalShieldEnabled', 'timezone', 'targetTimezone', 'timezoneMode', 'manualTimezone', 'geoTimezone', 'geolocationLatitude', 'geolocationLongitude', 'ipLatitude', 'ipLongitude', 'ipCity', 'languageTarget', 'theme', 'siteBypassList', ...MODULE_KEYS, ...MODULE_OPTION_KEYS], (res) => {
      if (chrome.runtime.lastError) {
        console.error('Failed to read settings:', chrome.runtime.lastError);
        showSettingsLoadError('扩展设置读取失败，当前页面不会保存任何修改。请刷新设置页重试。');
        return;
      }
      try {
        // 读回成功前 settingsLoaded 保持 false,saveState 与交互入口全部拒绝写入。
        fontMode = res.fontMode === 'whitelist' ? 'whitelist' : 'blacklist';
        customHiddenFonts = normalizeStoredFontList(res.customHiddenFonts);
        customAllowedFonts = normalizeStoredFontList(res.customAllowedFonts);
        blockBuiltinChineseFonts = typeof res.blockBuiltinChineseFonts === 'boolean' ? res.blockBuiltinChineseFonts : false;
        blockOtherScripts = typeof res.blockOtherScripts === 'boolean' ? res.blockOtherScripts : false;
        blockSymbols = typeof res.blockSymbols === 'boolean' ? res.blockSymbols : false;
        settingsLoaded = true;
        // 模块开关默认:位置伪装默认关闭,其余默认开启
        for (const key of MODULE_KEYS) {
          if (!moduleInputs[key]) continue;
          moduleInputs[key].checked = (key === 'geolocationProtection' || key === 'languageProtection') ? res[key] === true : res[key] !== false;
        }
        syncModuleUi();
        applyTzUI(res);
        applyGeoUI(res);
        applyIpUI(res);
        applyCityLanguage('system');
        if ($languageTarget) $languageTarget.value = normalizeLanguageTarget(res.languageTarget);
        const storedBypass = Array.isArray(res.siteBypassList) ? res.siteBypassList : [];
        bypassSites = sanitizeBypassSites(storedBypass);
        if (!sameStringArray(storedBypass, bypassSites)) {
          chrome.storage.local.set({ siteBypassList: bypassSites }, () => { void chrome.runtime.lastError; });
        }
        renderBypassList();
        for (const key of MODULE_OPTION_KEYS) {
          updateModuleOptionUI(key, DEFAULT_OFF_OPTION_KEYS.has(key) ? res[key] === true : res[key]);
        }
        if (!(typeof res.ipLatitude === 'number' && typeof res.ipLongitude === 'number') &&
            typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.sendMessage) {
          try {
            chrome.runtime.sendMessage({ type: 'SYNC_EGRESS' }, () => { void chrome.runtime.lastError; });
          } catch (_) {}
        }
        applyTheme(res.theme);
        applyShieldState(res.globalShieldEnabled !== false);
        showView((location.hash || '#canvas').slice(1));
        renderList();
        if ($settingsErrorBanner) $settingsErrorBanner.hidden = true;
        document.body.classList.remove('settings-loading', 'settings-error');
      } catch (err) {
        console.error('Failed to apply settings:', err);
        showSettingsLoadError('扩展设置已读取，但页面初始化失败。请刷新设置页重试。');
      }
    });
  } catch (err) {
    console.error('Failed to initialize settings panel:', err);
    showSettingsLoadError('扩展设置初始化失败，当前页面不会保存任何修改。请刷新设置页重试。');
  }
}

if ($languageTarget) {
  $languageTarget.addEventListener('change', () => {
    if (!settingsLoaded) return;
    chrome.storage.local.set({ languageTarget: normalizeLanguageTarget($languageTarget.value) });
    updateLanguagePreview();
  });
}

// ── 模块帮助：标题旁的小问号，点击列出每个子选项的具体影响 ──
const helpPopover = document.createElement('div');
helpPopover.className = 'help-popover';
helpPopover.hidden = true;
helpPopover.setAttribute('role', 'dialog');
helpPopover.setAttribute('aria-modal', 'false');
document.body.appendChild(helpPopover);
let activeHelpTrigger = null;

function escapeHelpText(value) {
  return String(value).replace(/[&<>"']/g, ch => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[ch]));
}

function normalizeHelpLabel(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function collectHelpEntries(viewId) {
  const view = document.getElementById('view-' + viewId);
  if (!view) return [];
  const entries = [];
  const push = (title, text) => {
    const cleanTitle = normalizeHelpLabel(title);
    const cleanText = normalizeHelpLabel(text);
    if (cleanTitle && cleanText) entries.push({ title: cleanTitle, text: cleanText });
  };

  if (viewId === 'fonts') {
    view.querySelectorAll('.mode-btn[data-help]').forEach(btn => {
      push('默认行为：' + normalizeHelpLabel(btn.textContent), btn.dataset.help);
    });
    const langTrigger = view.querySelector('.lang-pref-trigger[data-help]');
    if (langTrigger) {
      push(normalizeHelpLabel(langTrigger.querySelector('.ctl-label')?.textContent) || '按语言选择', langTrigger.dataset.help);
    }
    view.querySelectorAll('.sel-btn[data-help]').forEach(btn => {
      push(btn.textContent, btn.dataset.help);
    });
    const resetBtn = document.getElementById('btnResetDefaults');
    if (resetBtn?.dataset.help) push('恢复默认', resetBtn.dataset.help);
    return entries;
  }

  if (viewId === 'bypass') {
    return [
      { title: '网站例外', text: '加入例外后，该网站不会加载防护脚本，页面级保护会停用；全局追踪拦截和 WebRTC 网络策略仍会生效。' },
      { title: '添加网站', text: '输入域名或网址即可，支持子域；保存后刷新该网站即可生效。' },
      { title: '移除网站', text: '从名单移除后，刷新该网站即可恢复防护。' }
    ];
  }

  if (viewId === 'timezone') {
    view.querySelectorAll('.tp-layer-switch').forEach(label => {
      push(label.firstElementChild?.textContent, label.querySelector('.switch[data-help]')?.dataset.help);
    });
    view.querySelectorAll('.tp-chip[data-help]').forEach(btn => {
      push(btn.textContent, btn.dataset.help);
    });
    return entries;
  }

  view.querySelectorAll('.opt-row').forEach(row => {
    const help = row.dataset.help || row.querySelector('[data-help]')?.dataset.help;
    push(row.querySelector('.opt-title')?.textContent, help);
  });
  return entries;
}

function closeHelpPopover(restoreFocus = false) {
  const trigger = activeHelpTrigger;
  if (trigger) trigger.setAttribute('aria-expanded', 'false');
  activeHelpTrigger = null;
  helpPopover.hidden = true;
  if (restoreFocus && trigger) trigger.focus();
}

function openHelpPopover(trigger) {
  const viewId = trigger.dataset.helpView;
  const entries = collectHelpEntries(viewId);
  if (!entries.length) return;

  closeHelpPopover(false);
  const title = normalizeHelpLabel(trigger.closest('.view-title')?.querySelector('h2')?.textContent) || '选项';
  helpPopover.innerHTML = `
    <div class="help-popover-head">
      <span>${escapeHelpText(title)} 选项说明</span>
      <button type="button" class="help-popover-close" aria-label="关闭说明">×</button>
    </div>
    <div class="help-popover-body">
      ${entries.map(entry => `
        <div class="help-entry">
          <div class="help-entry-title">${escapeHelpText(entry.title)}</div>
          <div class="help-entry-note"><b>说明：</b>${escapeHelpText(entry.text)}</div>
        </div>
      `).join('')}
    </div>`;
  helpPopover.setAttribute('aria-label', title + ' 选项说明');
  helpPopover.hidden = false;
  helpPopover.style.visibility = 'hidden';
  activeHelpTrigger = trigger;
  trigger.setAttribute('aria-expanded', 'true');
  helpPopover.querySelector('.help-popover-close')?.addEventListener('click', () => closeHelpPopover(true));

  const triggerRect = trigger.getBoundingClientRect();
  const popRect = helpPopover.getBoundingClientRect();
  const margin = 12;
  let left = triggerRect.left;
  if (left + popRect.width > window.innerWidth - margin) {
    left = window.innerWidth - popRect.width - margin;
  }
  left = Math.max(margin, left);
  let top = triggerRect.bottom + 8;
  if (top + popRect.height > window.innerHeight - margin) {
    top = Math.max(margin, triggerRect.top - popRect.height - 8);
  }
  helpPopover.style.left = Math.round(left) + 'px';
  helpPopover.style.top = Math.round(top) + 'px';
  helpPopover.style.visibility = 'visible';
  requestAnimationFrame(() => { if (!helpPopover.hidden) helpPopover.querySelector('.help-popover-close')?.focus({ preventScroll: true }); });
}

document.querySelectorAll('.help-trigger').forEach(trigger => {
  trigger.addEventListener('click', event => {
    event.preventDefault();
    event.stopPropagation();
    if (activeHelpTrigger === trigger) closeHelpPopover(true);
    else openHelpPopover(trigger);
  });
});

document.addEventListener('click', event => {
  if (helpPopover.hidden) return;
  if (!(event.target instanceof Element)) return;
  if (event.target.closest('.help-popover') || event.target.closest('.help-trigger')) return;
  closeHelpPopover();
});

document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && !helpPopover.hidden) {
    event.preventDefault();
    closeHelpPopover(true);
  }
});

window.addEventListener('resize', () => {
  if (!helpPopover.hidden) closeHelpPopover();
});

window.addEventListener('scroll', event => {
  if (helpPopover.hidden) return;
  if (event.target instanceof Node && helpPopover.contains(event.target)) return;
  closeHelpPopover();
}, true);


init();
