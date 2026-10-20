'use strict';

// Shared regex for identifying CJK / domestic vendor fonts
const CHINESE_FONTS_REGEX = /(?:simsun|nsimsun|simhei|yahei|jhenghei|wenquanyi|pingfang|songti|kaiti|fangsong|dengxian|heiti|mingliu|pmingliu|st(?:heiti|kaiti|song|fangsong|xihei|zhongsong)|lisu|youyuan|biaukai|dfkai|source[ _-]?han|noto[ _-]?(?:sans|serif)?(?:[ _-]?mono)?[ _-]?(?:cjk|sc|tc|hk)|hiragino[ _-]?sans[ _-]?gb|misans|harmonyos|oppo|vivo|alipuhei|dingtalk|douyin|honor(?:[ _-]?sans)?|flyme|meizu|kingsoft|wps|micro[ _-]?hei|zen[ _-]?hei|fz[a-z0-9_-]*|founder|仓颉|华文|方正|汉仪|[\u4e00-\u9fa5])/i;

// Regex for identifying other non-Latin world scripts (Arabic, Hebrew, Indic, Thai, ancient scripts, etc.)
const OTHER_SCRIPTS_REGEX = /(?:arabic|kufi|naskh|nastaliq|urdu|hebrew|amiri|aldhabi|scheherazade|devanagari|bengali|gurmukhi|gujarati|oriya|tamil|telugu|kannada|malayalam|sinhala|tibetan|thai|lao|khmer|myanmar|javanese|sundanese|balinese|batak|tagalog|ethiopic|adlam|bamum|bassa|coptic|tifinagh|vai|cuneiform|hieroglyph|runic|cherokee|ogham|canadian[ _-]?aboriginal|linear[ _-]?[ab]|syriac|thaana|georgian|armenian|glagolitic|samaritan|shavian|brahmi|kharoshthi|sharada|chakma|cham|grantha|kaithi|dogra|khojki|khudawadi|lepcha|mahajani|mandaic|manichaean|marchen|gondi|medefaidrin|meetei|mende|meroitic|miao|modi|mongolian|newa|phaistos|rejang|saurashtra|siddham|sompeng|syloti|tagbanwa|tai[ _-]?(?:le|viet|tham)|takri|wancho|tirhuta|ugaritic|warang|zanabazar)/i;

// Regex for identifying symbol/dingbat fonts (independent category)
const SYMBOLS_REGEX = /(?:math|symbol|emoji|d050000l|z003|standard[ _-]?symbols|wingdings|webdings|dingbats?)/i;

// DOM Elements
const $modeControl = document.getElementById('modeControl');
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
const $selectAllBox = document.getElementById('selectAllBox');
const $selCount = document.getElementById('selCount');
const $btnSelectAll = document.getElementById('btnSelectAll');
const $btnInvert = document.getElementById('btnInvert');
const $btnHideSel = document.getElementById('btnHideSel');
const $btnShowSel = document.getElementById('btnShowSel');
const $btnClearSel = document.getElementById('btnClearSel');
const $btnResetDefaults = document.getElementById('btnResetDefaults');

// 眼睛图标:可见=睁眼,隐藏=眼斜杠,无需读表头即可理解
const EYE_ON = '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 12s3.5-6.5 10-6.5S22 12 22 12s-3.5 6.5-10 6.5S2 12 2 12z"/><circle cx="12" cy="12" r="2.6"/></svg>';
const EYE_OFF = '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 12s3.5-6.5 10-6.5S22 12 22 12s-3.5 6.5-10 6.5S2 12 2 12z"/><path d="M4 4l16 16"/></svg>';

// 语系徽章:分类识别用文字(图标适合动作,分类需要词汇)
const CAT_LABEL = { cjk: '中文', latin: '西文', other: '小语种', symbol: '符号' };
const CAT_TITLE = { cjk: '中文字体', latin: '西文字体', other: '其他语系', symbol: '符号字体' };

// State
let allFonts = [];
let customHiddenFonts = [];
let customAllowedFonts = [];
let blockBuiltinChineseFonts = true;
let blockOtherScripts = false;
let blockSymbols = false;
let fontMode = 'blacklist'; // 'blacklist' | 'whitelist'
let searchQuery = '';
let globalShieldEnabled = true; // 与 popup 共用的全局开关(chrome.storage.local.globalShieldEnabled)
let selectedFonts = new Set(); // 选择集:仅用于批量操作,与每行的隐藏/可见状态互相独立

// Sorting State
let sortField = 'none'; // 'none' | 'toggle' | 'name' | 'category'
let sortOrder = 'default';

function getFontCategory(name) {
  if (CHINESE_FONTS_REGEX.test(name)) return 'cjk';
  if (SYMBOLS_REGEX.test(name)) return 'symbol';
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
    if (blockSymbols && SYMBOLS_REGEX.test(name)) return true;
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
      if ((searchQuery === '其他' || searchQuery === '其他语种' || searchQuery === '多语种' || searchQuery === '小语种' || searchQuery === '冷门') && cat === 'other') return true;
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

    if (sortField === 'category') {
      const catA = getFontCategory(a);
      const catB = getFontCategory(b);
      const rank = {
        'cjk-first': { cjk: 0, latin: 1, other: 2, symbol: 3 },
        'latin-first': { latin: 0, cjk: 1, other: 2, symbol: 3 },
        'other-first': { other: 0, cjk: 1, latin: 2, symbol: 3 },
        'symbol-first': { symbol: 0, cjk: 1, latin: 2, other: 3 }
      }[sortOrder] || { cjk: 0, latin: 1, other: 2, symbol: 3 };

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
    updateSelectionUI();
    return;
  }

  $fontRows.innerHTML = list.map(f => {
    const checked = isFontChecked(f);
    const hidden = engineActive && isFontHidden(f);
    const cat = getFontCategory(f);
    const selected = selectedFonts.has(f);

    const badgeClass = 'glyph-badge';
    const badgeHtml = `<span class="${badgeClass}" title="${CAT_TITLE[cat]}">${CAT_LABEL[cat]}</span>`;

    // 眼睛按钮的语义随模式翻转,但对用户永远只有"可见/隐藏"两种呈现
    const eyeTooltip = !engineActive
      ? '防护已全局关闭：当前没有任何字体被隐藏'
      : (hidden ? '已隐藏，点击恢复可见' : '网站可见，点击隐藏');

    const rowAria = `${f}，${hidden ? '已对网站隐藏' : '网站可见'}${selected ? '，已选中' : ''}，点击选择`;

    return `
      <div class="font-row ${hidden ? 'is-hidden' : ''} ${selected ? 'selected' : ''}" data-font="${escapeHtml(f)}" role="button" tabindex="0" aria-label="${rowAria}">
        <div class="col-select">
          <input type="checkbox" class="row-select" data-font="${escapeHtml(f)}" ${selected ? 'checked' : ''} aria-label="选择 ${escapeHtml(f)}">
        </div>
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

  updateSelectionUI();
}

// 选择集 UI:计数、批量按钮可用性、表头全选/半选
function updateSelectionUI() {
  const n = selectedFonts.size;
  if ($selCount) $selCount.textContent = n ? `已选 ${n} 项` : '未选择';
  const actionsDisabled = n === 0 || !globalShieldEnabled;
  if ($btnHideSel) $btnHideSel.disabled = actionsDisabled;
  if ($btnShowSel) $btnShowSel.disabled = actionsDisabled;
  if ($btnClearSel) $btnClearSel.disabled = n === 0;

  const list = getProcessedFonts();
  if ($selectAllBox) {
    const selCount = list.filter(f => selectedFonts.has(f)).length;
    $selectAllBox.disabled = list.length === 0 || !globalShieldEnabled;
    $selectAllBox.checked = list.length > 0 && selCount === list.length;
    $selectAllBox.indeterminate = selCount > 0 && selCount < list.length;
  }
}

// 选择(不改变可见状态)
function toggleSelection(fontName) {
  if (!fontName) return;
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
  for (const f of getProcessedFonts()) selectedFonts.add(f);
  renderList();
}

function invertFiltered() {
  for (const f of getProcessedFonts()) {
    if (selectedFonts.has(f)) selectedFonts.delete(f);
    else selectedFonts.add(f);
  }
  renderList();
}

function clearSelection() {
  selectedFonts = new Set();
  renderList();
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
    // 模式语义翻转后旧选择不再有意义,清空避免批量操作误伤
    selectedFonts = new Set();
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
    } else if (sortOrder === 'other-first') {
      sortOrder = 'symbol-first';
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

// 设置单个字体的真实可见状态(黑/白名单模式各自映射回原有存储语义)
function setFontHidden(fontName, hidden) {
  const lower = fontName.toLowerCase();
  if (fontMode === 'blacklist') {
    if (hidden) {
      // 加入黑名单(隐藏)
      if (!customHiddenFonts.some(f => f.toLowerCase() === lower)) {
        customHiddenFonts.push(fontName);
      }
      customAllowedFonts = customAllowedFonts.filter(f => f.toLowerCase() !== lower);
    } else {
      // 移出黑名单(可见);被内建规则覆盖的需显式放行
      customHiddenFonts = customHiddenFonts.filter(f => f.toLowerCase() !== lower);
      if (CHINESE_FONTS_REGEX.test(fontName) || (blockOtherScripts && OTHER_SCRIPTS_REGEX.test(fontName))) {
        if (!customAllowedFonts.some(f => f.toLowerCase() === lower)) {
          customAllowedFonts.push(fontName);
        }
      }
    }
  } else {
    // 白名单模式: allowed 列表 = 可见集合
    if (hidden) {
      customAllowedFonts = customAllowedFonts.filter(f => f.toLowerCase() !== lower);
    } else {
      if (!customAllowedFonts.some(f => f.toLowerCase() === lower)) {
        customAllowedFonts.push(fontName);
      }
    }
  }
}

// 单行眼睛:直接翻转可见状态
function toggleFont(fontName) {
  if (!fontName || !globalShieldEnabled) return; // 全局关闭时不改配置,只读
  setFontHidden(fontName, !isFontHidden(fontName));
  saveState();
  renderList();
}

// 批量:隐藏/显示所选
function applyToSelection(hidden) {
  if (!globalShieldEnabled || selectedFonts.size === 0) return;
  for (const fontName of selectedFonts) {
    setFontHidden(fontName, hidden);
  }
  saveState();
  renderList();
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
if ($btnClearSel) $btnClearSel.addEventListener('click', clearSelection);
if ($selectAllBox) {
  $selectAllBox.addEventListener('change', () => {
    if ($selectAllBox.checked) selectAllFiltered();
    else clearSelection();
  });
}

// '/' 聚焦搜索
document.addEventListener('keydown', (e) => {
  if (e.key === '/' && document.activeElement !== $searchInput) {
    e.preventDefault();
    $searchInput && $searchInput.focus();
  }
});

// 恢复默认:字体配置回到初始态(不动全局总开关)
function restoreDefaults() {
  fontMode = 'blacklist';
  customHiddenFonts = [];
  customAllowedFonts = [];
  blockBuiltinChineseFonts = true;
  blockOtherScripts = false;
  blockSymbols = false;
  selectedFonts = new Set();
  saveState();
  renderList();
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
      changed = true;
    }
    if (changes.blockSymbols) {
      blockSymbols = typeof changes.blockSymbols.newValue === 'boolean' ? changes.blockSymbols.newValue : false;
      changed = true;
    }
    if (changes.globalShieldEnabled) {
      applyShieldState(changes.globalShieldEnabled.newValue !== false);
      changed = true;
    }
    // 模块开关跨上下文同步(popup ↔ 设置页)
    let moduleChanged = false;
    for (const key of MODULE_KEYS) {
      if (changes[key]) {
        const val = changes[key].newValue !== false;
        if (moduleInputs[key]) moduleInputs[key].checked = val;
        moduleChanged = true;
      }
    }
    if (moduleChanged) syncNavDotsFromInputs();
    if (changes.timezone || changes.targetTimezone) {
      chrome.storage.local.get(['timezone', 'targetTimezone'], updateTzInfo);
    }
    if (changes.theme) {
      applyTheme(changes.theme.newValue);
    }
    if (changed) renderList();
  }
});

// ── 设置页:模块开关 / 侧栏导航 / 时区信息 ──
const MODULE_KEYS = ['canvasProtection', 'webrtcProtection', 'audioProtection', 'timezoneProtection', 'hardwareProtection', 'fontProtection'];
const moduleInputs = {};
for (const key of MODULE_KEYS) {
  const el = document.getElementById(key);
  if (el) moduleInputs[key] = el;
}

function syncNavDotsFromInputs() {
  document.querySelectorAll('.nav-dot').forEach(dot => {
    const input = moduleInputs[dot.dataset.key];
    dot.classList.toggle('on', !!(input && input.checked));
  });
}

for (const [key, el] of Object.entries(moduleInputs)) {
  el.addEventListener('change', () => {
    chrome.storage.local.set({ [key]: el.checked });
    syncNavDotsFromInputs();
  });
}

// 视图路由:侧栏切换 + hash 深链(默认字体)
function showView(name) {
  let found = false;
  document.querySelectorAll('.view').forEach(v => {
    const match = v.dataset.view === name;
    v.hidden = !match;
    if (match) found = true;
  });
  if (!found) name = 'fonts';
  document.querySelectorAll('.nav-item').forEach(b => {
    b.setAttribute('aria-current', b.dataset.view === name ? 'page' : 'false');
  });
  if (location.hash !== '#' + name) history.replaceState(null, '', '#' + name);
}

document.querySelectorAll('.nav-item').forEach(btn => {
  btn.addEventListener('click', () => showView(btn.dataset.view));
});
window.addEventListener('hashchange', () => showView((location.hash || '#fonts').slice(1)));

// 时区模块:展示当前生效时区(由出口 IP 自动对齐,无手动配置)
function updateTzInfo(res) {
  const el = document.getElementById('tzInfo');
  if (!el) return;
  const tz = res && (res.timezone || res.targetTimezone);
  el.textContent = tz
    ? `当前生效时区：${tz}（随出口 IP 自动对齐）`
    : '当前生效时区：尚未对齐（随出口 IP 自动更新）';
}

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

  chrome.storage.local.get(['customHiddenFonts', 'customAllowedFonts', 'blockBuiltinChineseFonts', 'blockOtherScripts', 'blockSymbols', 'fontMode', 'globalShieldEnabled', 'timezone', 'targetTimezone', 'theme', ...MODULE_KEYS], (res) => {
    fontMode = res.fontMode === 'whitelist' ? 'whitelist' : 'blacklist';
    customHiddenFonts = Array.isArray(res.customHiddenFonts) ? res.customHiddenFonts : [];
    customAllowedFonts = Array.isArray(res.customAllowedFonts) ? res.customAllowedFonts : [];
    blockBuiltinChineseFonts = typeof res.blockBuiltinChineseFonts === 'boolean' ? res.blockBuiltinChineseFonts : true;
    blockOtherScripts = typeof res.blockOtherScripts === 'boolean' ? res.blockOtherScripts : false;
    blockSymbols = typeof res.blockSymbols === 'boolean' ? res.blockSymbols : false;
    // 模块开关默认全部开启
    for (const key of MODULE_KEYS) {
      if (moduleInputs[key]) moduleInputs[key].checked = res[key] !== false;
    }
    syncNavDotsFromInputs();
    updateTzInfo(res);
    applyTheme(res.theme);
    applyShieldState(res.globalShieldEnabled !== false);
    showView((location.hash || '#fonts').slice(1));
    renderList();
  });
}

init();
