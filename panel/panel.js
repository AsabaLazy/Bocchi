'use strict';

// Shared regex for identifying CJK / domestic vendor fonts
const CHINESE_FONTS_REGEX = /(?:simsun|nsimsun|simhei|yahei|jhenghei|wenquanyi|pingfang|songti|kaiti|fangsong|dengxian|heiti|mingliu|pmingliu|st(?:heiti|kaiti|song|fangsong|xihei|zhongsong)|lisu|youyuan|biaukai|dfkai|source[ _-]?han|noto[ _-]?(?:sans|serif)?(?:[ _-]?mono)?[ _-]?(?:cjk|sc|tc|hk)|hiragino[ _-]?sans[ _-]?gb|misans|harmonyos|oppo|vivo|alipuhei|dingtalk|douyin|honor(?:[ _-]?sans)?|flyme|meizu|kingsoft|wps|micro[ _-]?hei|zen[ _-]?hei|fz[a-z0-9_-]*|founder|仓颉|华文|方正|汉仪|[\u4e00-\u9fa5])/i;

// Regex for identifying other non-Latin world scripts (Arabic, Hebrew, Indic, Thai, ancient scripts, symbols, etc.)
const OTHER_SCRIPTS_REGEX = /(?:arabic|kufi|naskh|nastaliq|urdu|hebrew|amiri|aldhabi|scheherazade|devanagari|bengali|gurmukhi|gujarati|oriya|tamil|telugu|kannada|malayalam|sinhala|tibetan|thai|lao|khmer|myanmar|javanese|sundanese|balinese|batak|tagalog|ethiopic|adlam|bamum|bassa|coptic|tifinagh|vai|cuneiform|hieroglyph|runic|cherokee|ogham|canadian[ _-]?aboriginal|linear[ _-]?[ab]|math|symbol|emoji|d050000l|z003|standard[ _-]?symbols|syriac|thaana|georgian|armenian|glagolitic|samaritan|shavian|brahmi|kharoshthi|sharada|chakma|cham|grantha|kaithi|dogra|khojki|khudawadi|lepcha|mahajani|mandaic|manichaean|marchen|gondi|medefaidrin|meetei|mende|meroitic|miao|modi|mongolian|newa|phaistos|rejang|saurashtra|siddham|sompeng|syloti|tagbanwa|tai[ _-]?(?:le|viet|tham)|takri|wancho|tirhuta|ugaritic|warang|zanabazar)/i;

// DOM Elements
const $modeControl = document.getElementById('modeControl');
const $modeHint = document.getElementById('modeHint');
const $toggleOtherScripts = document.getElementById('toggleOtherScripts');
const $searchInput = document.getElementById('searchInput');
const $fontCount = document.getElementById('fontCount');
const $headerToggle = document.getElementById('headerToggle');
const $iconToggle = document.getElementById('iconToggle');
const $headerName = document.getElementById('headerName');
const $iconName = document.getElementById('iconName');
const $headerCategory = document.getElementById('headerCategory');
const $iconCategory = document.getElementById('iconCategory');
const $fontRows = document.getElementById('fontRows');

// State
let allFonts = [];
let customHiddenFonts = [];
let customAllowedFonts = [];
let blockBuiltinChineseFonts = true;
let blockOtherScripts = false;
let fontMode = 'blacklist'; // 'blacklist' | 'whitelist'
let searchQuery = '';

// Sorting State
let sortField = 'none'; // 'none' | 'toggle' | 'name' | 'category'
let sortOrder = 'default';

function getFontCategory(name) {
  if (CHINESE_FONTS_REGEX.test(name)) return 'cjk';
  if (OTHER_SCRIPTS_REGEX.test(name)) return 'other';
  return 'latin';
}

function isFontCjk(name) {
  return CHINESE_FONTS_REGEX.test(name);
}

function isFontChecked(name) {
  const lower = name.toLowerCase();
  if (fontMode === 'blacklist') {
    // 黑名单模式：勾选 = 加入黑名单（脱敏隐藏）
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
      if ((searchQuery === '其他' || searchQuery === '其他语种' || searchQuery === '多语种') && cat === 'other') return true;
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

function updateSortHeaders() {
  if ($headerToggle && $iconToggle) {
    if (sortField === 'toggle') {
      $iconToggle.textContent = sortOrder === 'checked-first' ? '↑' : '↓';
      $headerToggle.classList.add('active');
    } else {
      $iconToggle.textContent = '↕';
      $headerToggle.classList.remove('active');
    }
  }

  if ($headerName && $iconName) {
    if (sortField === 'name') {
      $iconName.textContent = sortOrder === 'asc' ? '↑' : '↓';
      $headerName.classList.add('active');
    } else {
      $iconName.textContent = '↕';
      $headerName.classList.remove('active');
    }
  }

  if ($headerCategory && $iconCategory) {
    if (sortField === 'category') {
      if (sortOrder === 'cjk-first') {
        $iconCategory.textContent = '↑ 中文';
      } else if (sortOrder === 'latin-first') {
        $iconCategory.textContent = '↑ 西文';
      } else if (sortOrder === 'other-first') {
        $iconCategory.textContent = '↑ 其他';
      }
      $headerCategory.classList.add('active');
    } else {
      $iconCategory.textContent = '↕';
      $headerCategory.classList.remove('active');
    }
  }
}

function renderList() {
  updateSortHeaders();

  // Update mode UI
  document.querySelectorAll('.mode-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.mode === fontMode);
  });
  if ($modeHint) {
    if (fontMode === 'blacklist') {
      $modeHint.textContent = '黑名单模式：勾选的字体将被脱敏隐藏，未勾选保持可见';
    } else {
      $modeHint.textContent = '白名单模式：仅勾选的字体允许显示，未勾选全部隐藏';
    }
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
    const hidden = isFontHidden(f);
    const cat = getFontCategory(f);

    let badgeHtml = '';
    if (cat === 'cjk') {
      badgeHtml = '<span class="badge badge-cjk">中文</span>';
    } else if (cat === 'other') {
      badgeHtml = '<span class="badge badge-other">其他语种</span>';
    } else {
      badgeHtml = '<span class="badge badge-latin">西文</span>';
    }

    const switchTooltip = fontMode === 'blacklist'
      ? (checked ? '已加入黑名单（脱敏隐藏），点击移出黑名单' : '未在黑名单（保持可见），点击加入黑名单')
      : (checked ? '已加入白名单（保持可见），点击移出白名单' : '未在白名单（脱敏隐藏），点击加入白名单');

    return `
      <div class="font-row ${hidden ? 'is-hidden' : ''}" data-font="${escapeHtml(f)}">
        <div class="col-toggle">
          <label class="switch" title="${switchTooltip}">
            <input type="checkbox" class="toggle-font" data-font="${escapeHtml(f)}" ${checked ? 'checked' : ''}>
            <span class="slider"></span>
          </label>
        </div>
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

// Toggle font handler (event delegation)
$fontRows.addEventListener('change', (e) => {
  const checkbox = e.target.closest('.toggle-font');
  if (!checkbox) return;

  const fontName = checkbox.dataset.font;
  if (!fontName) return;

  const isChecked = checkbox.checked;
  const lower = fontName.toLowerCase();

  if (fontMode === 'blacklist') {
    if (isChecked) {
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
    if (isChecked) {
      if (!customAllowedFonts.some(f => f.toLowerCase() === lower)) {
        customAllowedFonts.push(fontName);
      }
    } else {
      customAllowedFonts = customAllowedFonts.filter(f => f.toLowerCase() !== lower);
    }
  }

  saveState();
  renderList();
});

// Toggle other minority scripts batch switch
if ($toggleOtherScripts) {
  $toggleOtherScripts.addEventListener('change', () => {
    blockOtherScripts = $toggleOtherScripts.checked;
    saveState();
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

  chrome.storage.local.get(['customHiddenFonts', 'customAllowedFonts', 'blockBuiltinChineseFonts', 'blockOtherScripts', 'fontMode'], (res) => {
    fontMode = res.fontMode === 'whitelist' ? 'whitelist' : 'blacklist';
    customHiddenFonts = Array.isArray(res.customHiddenFonts) ? res.customHiddenFonts : [];
    customAllowedFonts = Array.isArray(res.customAllowedFonts) ? res.customAllowedFonts : [];
    blockBuiltinChineseFonts = typeof res.blockBuiltinChineseFonts === 'boolean' ? res.blockBuiltinChineseFonts : true;
    blockOtherScripts = typeof res.blockOtherScripts === 'boolean' ? res.blockOtherScripts : false;
    if ($toggleOtherScripts) {
      $toggleOtherScripts.checked = blockOtherScripts;
    }
    renderList();
  });
}

init();
