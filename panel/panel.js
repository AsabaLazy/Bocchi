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
    if (moduleChanged) {
      syncNavDotsFromInputs();
      renderConsole();
    }
    if (changes.timezone || changes.targetTimezone || changes.timezoneMode || changes.manualTimezone || changes.geoTimezone) {
      chrome.storage.local.get(['timezone', 'targetTimezone', 'timezoneMode', 'manualTimezone', 'geoTimezone'], applyTzUI);
    }
    if (changes.geolocationLatitude || changes.geolocationLongitude) {
      chrome.storage.local.get(['geolocationLatitude', 'geolocationLongitude'], applyGeoUI);
    }
    if (changes.ipLatitude || changes.ipLongitude || changes.ipCity) {
      chrome.storage.local.get(['ipLatitude', 'ipLongitude', 'ipCity'], applyIpUI);
    }
    if (changes.cityNameLanguage) {
      if ($cityNameLanguage) $cityNameLanguage.value = changes.cityNameLanguage.newValue || 'system';
      applyCityLanguage(changes.cityNameLanguage.newValue || 'system');
    }
    if (changes.theme) {
      applyTheme(changes.theme.newValue);
    }
    if (changed) renderList();
  }
});

// ── 设置页:模块开关 / 侧栏导航 / 时区信息 ──
const MODULE_KEYS = ['canvasProtection', 'webrtcProtection', 'audioProtection', 'timezoneProtection', 'geolocationProtection', 'hardwareProtection', 'fontProtection'];
const moduleInputs = {};
for (const key of MODULE_KEYS) {
  const el = document.getElementById(key);
  if (el) moduleInputs[key] = el;
}

function syncNavDotsFromInputs() {
  document.querySelectorAll('.nav-dot').forEach(dot => {
    const primary = moduleInputs[dot.dataset.key];
    const anyInput = dot.dataset.keyAny ? moduleInputs[dot.dataset.keyAny] : null;
    const on = (primary && primary.checked) || (anyInput && anyInput.checked);
    dot.classList.toggle('on', !!on);
  });
}

for (const [key, el] of Object.entries(moduleInputs)) {
  el.addEventListener('change', () => {
    chrome.storage.local.set({ [key]: el.checked });
    onModuleToggle(key, el.checked);
  });
}

// 视图路由:侧栏切换 + hash 深链(默认字体)
function showView(name) {
  if (name === 'geolocation') name = 'timezone'; // 合并后的旧深链兼容
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
const $cityNameLanguage = document.getElementById('cityNameLanguage');
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
    return formatter(dateFmtCache, zone, { locale: 'zh-CN', options: { month: 'long', day: 'numeric', weekday: 'short' } }).format(new Date());
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
  chrome.storage.local.set({ geolocationLatitude: geoLat, geolocationLongitude: geoLng });
}

function commitPin() {
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

  // 虚线圆 = 当前出口 IP 的大致位置;粉点 = 伪装坐标。
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
    // 粉点已经落在出口 IP 上时，不再叠加虚线圈、标签和连线。
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
          ? '当前出口 IP 的大致位置' + (ipCity ? ' · ' + ipCity : '') + ` · ${ipLat.toFixed(2)}, ${ipLng.toFixed(2)}`
          : '按出口 IP 的时区估算 · ' + autoTzValue;
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
  if (placeEn) placeEn.textContent = placeSecondary;
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
  document.querySelectorAll('.tp-layer').forEach(layer => {
    const on = layer.dataset.layer === 'tz' ? tzOn : geoOn;
    layer.classList.toggle('on', on);
    layer.setAttribute('aria-pressed', on ? 'true' : 'false');
  });
  if ($tzSelect) $tzSelect.hidden = tzMode !== 'manual';

  const mismatch = tzOn && geoOn && tzMode !== 'geo' && !!derived && zone !== derived;
  if ($tzMismatch) $tzMismatch.hidden = !mismatch;

  let note = '';
  if (!tzOn) note = '时区层已关闭，网站看到真实时区';
  else if (!geoOn && tzMode === 'geo') note = '位置层已关闭，时区回退出口 IP';
  else if (tzMode === 'geo') note = '时区跟随位置';
  else if (tzMode === 'auto') note = '时区由出口 IP 决定';
  else note = '时区已手动锁定';
  if ($tzNote) $tzNote.textContent = note;
}

// 时区来源
function setTzSource(mode) {
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
    chrome.storage.local.set({ manualTimezone: $tzSelect.value, timezoneMode: 'manual' });
  });
}

// 图层眼睛:直接切换现有模块开关
document.querySelectorAll('.tp-layer').forEach(layer => {
  layer.addEventListener('click', () => {
    const key = layer.dataset.layer === 'tz' ? 'timezoneProtection' : 'geolocationProtection';
    const input = moduleInputs[key];
    if (!input) return;
    input.checked = !input.checked;
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });
});

// 模块开关变化:开启位置层时,时区默认跟随位置(仅从自动切换)
function onModuleToggle(key, on) {
  syncNavDotsFromInputs();
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

// 拖动粉点:实时预览,松手提交
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
  if (e.key === '/' && e.target !== $citySearch && !/^(INPUT|SELECT|TEXTAREA)$/.test((e.target && e.target.tagName) || '')) {
    e.preventDefault();
    if ($citySearch) $citySearch.focus();
  }
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
    if (!$geoProtection.checked) return;
    chrome.storage.local.get(['geolocationLatitude', 'geolocationLongitude'], (r) => {
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
  await loadCityData();
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

  chrome.storage.local.get(['customHiddenFonts', 'customAllowedFonts', 'blockBuiltinChineseFonts', 'blockOtherScripts', 'blockSymbols', 'fontMode', 'globalShieldEnabled', 'timezone', 'targetTimezone', 'timezoneMode', 'manualTimezone', 'geoTimezone', 'geolocationLatitude', 'geolocationLongitude', 'ipLatitude', 'ipLongitude', 'ipCity', 'cityNameLanguage', 'theme', ...MODULE_KEYS], (res) => {
    fontMode = res.fontMode === 'whitelist' ? 'whitelist' : 'blacklist';
    customHiddenFonts = Array.isArray(res.customHiddenFonts) ? res.customHiddenFonts : [];
    customAllowedFonts = Array.isArray(res.customAllowedFonts) ? res.customAllowedFonts : [];
    blockBuiltinChineseFonts = typeof res.blockBuiltinChineseFonts === 'boolean' ? res.blockBuiltinChineseFonts : true;
    blockOtherScripts = typeof res.blockOtherScripts === 'boolean' ? res.blockOtherScripts : false;
    blockSymbols = typeof res.blockSymbols === 'boolean' ? res.blockSymbols : false;
    // 模块开关默认:位置伪装默认关闭,其余默认开启
    for (const key of MODULE_KEYS) {
      if (!moduleInputs[key]) continue;
      moduleInputs[key].checked = key === 'geolocationProtection' ? res[key] === true : res[key] !== false;
    }
    syncNavDotsFromInputs();
    applyTzUI(res);
    applyGeoUI(res);
    applyIpUI(res);
    if ($cityNameLanguage) $cityNameLanguage.value = res.cityNameLanguage || 'system';
    applyCityLanguage(res.cityNameLanguage || 'system');
    if (!(typeof res.ipLatitude === 'number' && typeof res.ipLongitude === 'number') &&
        typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.sendMessage) {
      try {
        chrome.runtime.sendMessage({ type: 'SYNC_EGRESS' }, () => { void chrome.runtime.lastError; });
      } catch (_) {}
    }
    applyTheme(res.theme);
    applyShieldState(res.globalShieldEnabled !== false);
    showView((location.hash || '#fonts').slice(1));
    renderList();
  });
}

if ($cityNameLanguage) {
  $cityNameLanguage.addEventListener('change', () => {
    chrome.storage.local.set({ cityNameLanguage: $cityNameLanguage.value });
    applyCityLanguage($cityNameLanguage.value);
  });
}

init();
