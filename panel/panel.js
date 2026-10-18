'use strict';

// Shared regex for identifying CJK / domestic vendor fonts
const CHINESE_FONTS_REGEX = /(?:simsun|nsimsun|simhei|yahei|jhenghei|wenquanyi|pingfang|songti|kaiti|fangsong|dengxian|heiti|mingliu|pmingliu|st(?:heiti|kaiti|song|fangsong|xihei|zhongsong)|lisu|youyuan|biaukai|dfkai|source[ _-]?han|noto[ _-]?(?:sans|serif)?(?:[ _-]?mono)?[ _-]?(?:cjk|sc|tc|hk)|hiragino[ _-]?sans[ _-]?gb|misans|harmonyos|oppo|vivo|alipuhei|dingtalk|douyin|honor(?:[ _-]?sans)?|flyme|meizu|kingsoft|wps|micro[ _-]?hei|zen[ _-]?hei|fz[a-z0-9_-]*|founder|仓颉|华文|方正|汉仪|[\u4e00-\u9fa5])/i;

// Regex for identifying other non-Latin world scripts (Arabic, Hebrew, Indic, Thai, ancient scripts, symbols, etc.)
const OTHER_SCRIPTS_REGEX = /(?:arabic|kufi|naskh|nastaliq|urdu|hebrew|amiri|aldhabi|scheherazade|devanagari|bengali|gurmukhi|gujarati|oriya|tamil|telugu|kannada|malayalam|sinhala|tibetan|thai|lao|khmer|myanmar|javanese|sundanese|balinese|batak|tagalog|ethiopic|adlam|bamum|bassa|coptic|tifinagh|vai|cuneiform|hieroglyph|runic|cherokee|ogham|canadian[ _-]?aboriginal|linear[ _-]?[ab]|math|symbol|emoji|d050000l|z003|standard[ _-]?symbols|syriac|thaana|georgian|armenian|glagolitic|samaritan|shavian|brahmi|kharoshthi|sharada|chakma|cham|grantha|kaithi|dogra|khojki|khudawadi|lepcha|mahajani|mandaic|manichaean|marchen|gondi|medefaidrin|meetei|mende|meroitic|miao|modi|mongolian|newa|phaistos|rejang|saurashtra|siddham|sompeng|syloti|tagbanwa|tai[ _-]?(?:le|viet|tham)|takri|wancho|tirhuta|ugaritic|warang|zanabazar)/i;

// DOM Elements
const $modeControl = document.getElementById('modeControl');
const $toggleOtherScripts = document.getElementById('toggleOtherScripts');
const $scriptChip = document.getElementById('scriptChip');
const $searchInput = document.getElementById('searchInput');
const $fontCount = document.getElementById('fontCount');
const $headerToggle = document.getElementById('headerToggle');
const $iconToggle = document.getElementById('iconToggle');
const $headerName = document.getElementById('headerName');
const $iconName = document.getElementById('iconName');
const $headerCategory = document.getElementById('headerCategory');
const $iconCategory = document.getElementById('iconCategory');
const $fontRows = document.getElementById('fontRows');
const $globalShieldEnabled = document.getElementById('globalShieldEnabled');
const $statusText = document.getElementById('statusText');
const $barVis = document.getElementById('barVis');
const $barHid = document.getElementById('barHid');
const $nVis = document.getElementById('nVis');
const $nHid = document.getElementById('nHid');

// 眼睛图标:可见=睁眼,隐藏=眼斜杠,无需读表头即可理解
const EYE_ON = '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 12s3.5-6.5 10-6.5S22 12 22 12s-3.5 6.5-10 6.5S2 12 2 12z"/><circle cx="12" cy="12" r="2.6"/></svg>';
const EYE_OFF = '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 12s3.5-6.5 10-6.5S22 12 22 12s-3.5 6.5-10 6.5S2 12 2 12z"/><path d="M4 4l16 16"/></svg>';

// 语系徽章:字形即分类
const CAT_GLYPH = { cjk: '字', latin: 'Aa', other: 'أ' };
const CAT_TITLE = { cjk: '中文字体', latin: '西文字体', other: '其他语系' };

// State
let allFonts = [];
let customHiddenFonts = [];
let customAllowedFonts = [];
let blockBuiltinChineseFonts = true;
let blockOtherScripts = false;
let fontMode = 'blacklist'; // 'blacklist' | 'whitelist'
let searchQuery = '';
let globalShieldEnabled = true; // 与 popup 共用的全局开关(chrome.storage.local.globalShieldEnabled)

// Sorting State
let sortField = 'none'; // 'none' | 'toggle' | 'name' | 'category'
let sortOrder = 'default';

function getFontCategory(name) {
  if (CHINESE_FONTS_REGEX.test(name)) return 'cjk';
  if (OTHER_SCRIPTS_REGEX.test(name)) return 'other';
  return 'latin';
}

function isFontChecked(name) {
  const lower = name.toLowerCase();
  if (fontMode === 'blacklist') {
    // 黑名单模式：勾选 = 加入黑名单（隐藏，字体仍正常渲染）
    if (customAllowedFonts.some(f => f.toLowerCase() === lower)) {
      return false;
    }
    if (customHiddenFonts.some(r => {
      const s = r && r.trim();
      if (!s) return false;
      if (s.startsWith('/') && s.length > 2 && s.endsWith('/')) {
        try { return new RegExp(s.slice(1, -1), 'i').test(name); } catch (_) {}
      }
      return lower === s.toLowerCase() || lower.includes(s.toLowerCase());
    })) {
      return true;
    }
    if (blockBuiltinChineseFonts && CHINESE_FONTS_REGEX.test(name)) return true;
    if (blockOtherScripts && OTHER_SCRIPTS_REGEX.test(name)) return true;
    return false;
  } else {
    // 白名单模式：勾选 = 加入白名单（仅放行勾选字体，不被隐藏）
    return customAllowedFonts.some(f => f.toLowerCase() === lower);
  }
}

function isFontHidden(name) {
  if (fontMode === 'blacklist') {
    return isFontChecked(name);
  } else {
    // 白名单模式下只有勾选的字体不被隐藏
    return !isFontChecked(name);
  }
}

function saveState() {
  chrome.storage.local.set({
    fontMode,
    customHiddenFonts,
    customAllowedFonts,
    blockBuiltinChineseFonts,
    blockOtherScripts
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
      if ((searchQuery === '其他' || searchQuery === '其他语种' || searchQuery === '多语种' || searchQuery === '小语种' || searchQuery === '冷门') && cat === 'other') return true;
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

    if (sortField === 'category') {
      const catA = getFontCategory(a);
      const catB = getFontCategory(b);
      const rank = {
        'cjk-first': { cjk: 0, latin: 1, other: 2 },
        'latin-first': { latin: 0, cjk: 1, other: 2 },
        'other-first': { other: 0, cjk: 1, latin: 2 }
      }[sortOrder] || { cjk: 0, latin: 1, other: 2 };

      const diff = rank[catA] - rank[catB];
      if (diff !== 0) return diff;
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

  if ($headerCategory && $iconCategory) {
    if (sortField === 'category') {
      // 三种语系优先序视为该列的排序形态,统一报 ascending
      $iconCategory.textContent = '↑';
      $headerCategory.classList.add('active');
      $headerCategory.setAttribute('aria-sort', 'ascending');
    } else {
      $iconCategory.textContent = '↕';
      $headerCategory.classList.remove('active');
      $headerCategory.setAttribute('aria-sort', 'none');
    }
  }
}

function renderList() {
  updateSortHeaders();

  // Update mode UI (点阵按钮的 active 态即当前模式)
  document.querySelectorAll('.mode-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.mode === fontMode);
  });

  // 语种批处理 chip 状态
  if ($scriptChip) {
    $scriptChip.classList.toggle('on', blockOtherScripts);
  }

  // 比例条:全库可见/隐藏统计(全局关闭时一切都是"可见"的诚实呈现)
  const engineActive = globalShieldEnabled;
  const nHid = engineActive ? allFonts.filter(f => isFontHidden(f)).length : 0;
  const nVis = allFonts.length - nHid;
  if ($nVis && $nHid && $barVis && $barHid) {
    $nVis.textContent = nVis;
    $nHid.textContent = nHid;
    const tot = allFonts.length || 1;
    $barVis.style.width = (nVis / tot * 100) + '%';
    $barHid.style.width = (nHid / tot * 100) + '%';
  }

  const list = getProcessedFonts();

  if ($fontCount) {
    if (searchQuery) {
      $fontCount.textContent = `匹配 ${list.length} / ${allFonts.length} 款`;
    } else {
      $fontCount.textContent = `共 ${allFonts.length} 款字体`;
    }
  }

  if (list.length === 0) {
    $fontRows.innerHTML = `<div class="no-result">${searchQuery ? '未找到匹配的字体' : '未检索到已安装字体'}</div>`;
    return;
  }

  $fontRows.innerHTML = list.map(f => {
    const checked = isFontChecked(f);
    const hidden = engineActive && isFontHidden(f);
    const cat = getFontCategory(f);

    const badgeClass = cat === 'latin' ? ' glyph-badge lat' : ' glyph-badge';
    const badgeHtml = `<span class="${badgeClass.trim()}" title="${CAT_TITLE[cat]}">${CAT_GLYPH[cat]}</span>`;

    // 眼睛按钮的语义随模式翻转,但对用户永远只有"可见/隐藏"两种呈现
    const eyeTooltip = !engineActive
      ? '防护已全局关闭：当前没有任何字体被隐藏'
      : (hidden ? '已隐藏，点击恢复可见' : '网站可见，点击隐藏');

    const rowAria = `${f}，${hidden ? '已对网站隐藏' : '网站可见'}，点击切换`;

    return `
      <div class="font-row ${hidden ? 'is-hidden' : ''}" data-font="${escapeHtml(f)}" role="button" tabindex="0" aria-label="${rowAria}">
        <button type="button" class="eye" data-font="${escapeHtml(f)}" title="${eyeTooltip}" aria-label="${eyeTooltip}">${hidden ? EYE_OFF : EYE_ON}</button>
        <div class="col-name">
          <span class="font-title" style="font-family: '${escapeHtml(f)}', sans-serif;">${escapeHtml(f)}</span>
        </div>
        <div class="col-badge">
          ${badgeHtml}
        </div>
      </div>
    `;
  }).join('');
}

// Search input
if ($searchInput) {
  $searchInput.addEventListener('input', () => {
    searchQuery = $searchInput.value.trim().toLowerCase();
    renderList();
  });
}

// Mode selector click
if ($modeControl) {
  $modeControl.addEventListener('click', (e) => {
    const btn = e.target.closest('.mode-btn');
    if (!btn) return;
    const targetMode = btn.dataset.mode;
    if (!targetMode || targetMode === fontMode) return;

    fontMode = targetMode;
    if (fontMode === 'whitelist' && customAllowedFonts.length === 0) {
      customAllowedFonts = allFonts.filter(f => !CHINESE_FONTS_REGEX.test(f));
    }
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

// Header sorting: Category
if ($headerCategory) {
  $headerCategory.addEventListener('click', () => {
    if (sortField !== 'category') {
      sortField = 'category';
      sortOrder = 'cjk-first';
    } else if (sortOrder === 'cjk-first') {
      sortOrder = 'latin-first';
    } else if (sortOrder === 'latin-first') {
      sortOrder = 'other-first';
    } else {
      sortField = 'none';
      sortOrder = 'default';
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

// Toggle font handler:整行或眼睛按钮均可点击(键盘 Enter/Space 同效),落库逻辑不变
function toggleFont(fontName) {
  if (!fontName || !globalShieldEnabled) return; // 全局关闭时不改配置,只读

  const lower = fontName.toLowerCase();
  const checked = !isFontChecked(fontName); // 点击 = 翻转当前状态

  if (fontMode === 'blacklist') {
    if (checked) {
      // Add to blacklist (hide)
      if (!customHiddenFonts.some(f => f.toLowerCase() === lower)) {
        customHiddenFonts.push(fontName);
      }
      customAllowedFonts = customAllowedFonts.filter(f => f.toLowerCase() !== lower);
    } else {
      // Remove from blacklist (allow)
      customHiddenFonts = customHiddenFonts.filter(f => f.toLowerCase() !== lower);
      if (CHINESE_FONTS_REGEX.test(fontName) || (blockOtherScripts && OTHER_SCRIPTS_REGEX.test(fontName))) {
        if (!customAllowedFonts.some(f => f.toLowerCase() === lower)) {
          customAllowedFonts.push(fontName);
        }
      }
    }
  } else {
    // Whitelist mode: checked = in whitelist (allowed)
    if (checked) {
      if (!customAllowedFonts.some(f => f.toLowerCase() === lower)) {
        customAllowedFonts.push(fontName);
      }
    } else {
      customAllowedFonts = customAllowedFonts.filter(f => f.toLowerCase() !== lower);
    }
  }

  saveState();
  renderList();
}

$fontRows.addEventListener('click', (e) => {
  const row = e.target.closest('.font-row');
  if (!row) return;
  toggleFont(row.dataset.font);
});

$fontRows.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' && e.key !== ' ') return;
  const row = e.target.closest('.font-row');
  if (!row) return;
  e.preventDefault();
  toggleFont(row.dataset.font);
});

// Toggle other minority scripts batch switch
if ($toggleOtherScripts) {
  $toggleOtherScripts.addEventListener('change', () => {
    blockOtherScripts = $toggleOtherScripts.checked;
    saveState();
    renderList();
  });
}

// '/' 聚焦搜索
document.addEventListener('keydown', (e) => {
  if (e.key === '/' && document.activeElement !== $searchInput) {
    e.preventDefault();
    $searchInput && $searchInput.focus();
  }
});

// 全局总开关:与 popup 共用 chrome.storage.local.globalShieldEnabled
function applyShieldState(enabled) {
  globalShieldEnabled = !!enabled;
  document.body.classList.toggle('off', !globalShieldEnabled);
  if ($globalShieldEnabled) {
    $globalShieldEnabled.checked = globalShieldEnabled;
  }
  if ($statusText) {
    $statusText.textContent = globalShieldEnabled ? '防护运行中' : '防护已关闭';
  }
}

if ($globalShieldEnabled) {
  $globalShieldEnabled.addEventListener('change', () => {
    globalShieldEnabled = $globalShieldEnabled.checked;
    chrome.storage.local.set({ globalShieldEnabled });
    applyShieldState(globalShieldEnabled);
    renderList();
  });
}

// Cross-tab / storage sync
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local') {
    let changed = false;
    if (changes.fontMode) {
      fontMode = changes.fontMode.newValue === 'whitelist' ? 'whitelist' : 'blacklist';
      changed = true;
    }
    if (changes.customHiddenFonts) {
      customHiddenFonts = Array.isArray(changes.customHiddenFonts.newValue) ? changes.customHiddenFonts.newValue : [];
      changed = true;
    }
    if (changes.customAllowedFonts) {
      customAllowedFonts = Array.isArray(changes.customAllowedFonts.newValue) ? changes.customAllowedFonts.newValue : [];
      changed = true;
    }
    if (changes.blockBuiltinChineseFonts) {
      blockBuiltinChineseFonts = typeof changes.blockBuiltinChineseFonts.newValue === 'boolean' ? changes.blockBuiltinChineseFonts.newValue : true;
      changed = true;
    }
    if (changes.blockOtherScripts) {
      blockOtherScripts = typeof changes.blockOtherScripts.newValue === 'boolean' ? changes.blockOtherScripts.newValue : false;
      if ($toggleOtherScripts) {
        $toggleOtherScripts.checked = blockOtherScripts;
      }
      changed = true;
    }
    if (changes.globalShieldEnabled) {
      applyShieldState(changes.globalShieldEnabled.newValue !== false);
      changed = true;
    }
    if (changed) renderList();
  }
});

// Initialize
async function init() {
  try {
    if (chrome.fontSettings && chrome.fontSettings.getFontList) {
      const list = await chrome.fontSettings.getFontList();
      allFonts = list.map(f => f.displayName || f.fontId).filter(Boolean);
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

  chrome.storage.local.get(['customHiddenFonts', 'customAllowedFonts', 'blockBuiltinChineseFonts', 'blockOtherScripts', 'fontMode', 'globalShieldEnabled'], (res) => {
    fontMode = res.fontMode === 'whitelist' ? 'whitelist' : 'blacklist';
    customHiddenFonts = Array.isArray(res.customHiddenFonts) ? res.customHiddenFonts : [];
    customAllowedFonts = Array.isArray(res.customAllowedFonts) ? res.customAllowedFonts : [];
    blockBuiltinChineseFonts = typeof res.blockBuiltinChineseFonts === 'boolean' ? res.blockBuiltinChineseFonts : true;
    blockOtherScripts = typeof res.blockOtherScripts === 'boolean' ? res.blockOtherScripts : false;
    if ($toggleOtherScripts) {
      $toggleOtherScripts.checked = blockOtherScripts;
    }
    applyShieldState(res.globalShieldEnabled !== false);
    renderList();
  });
}

init();
