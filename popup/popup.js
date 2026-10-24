'use strict';

// DOM Elements
const $globalShieldEnabled = document.getElementById('globalShieldEnabled');
const $statusBadge = document.getElementById('statusBadge');
const $statusText = document.getElementById('statusText');

const $siteDomain = document.getElementById('siteDomain');
const $siteStatusText = document.getElementById('siteStatusText');
const $siteBypass = document.getElementById('siteBypass');
const $siteActionDesc = document.getElementById('siteActionDesc');

const $modulesList = document.getElementById('modulesList');
const $canvasProtection = document.getElementById('canvasProtection');
const $webrtcProtection = document.getElementById('webrtcProtection');
const $audioProtection = document.getElementById('audioProtection');
const $timezoneProtection = document.getElementById('timezoneProtection');
const $languageProtection = document.getElementById('languageProtection');
const $hardwareProtection = document.getElementById('hardwareProtection');
const $fontProtection = document.getElementById('fontProtection');
const $geolocationProtection = document.getElementById('geolocationProtection');

const $btnOpenPanel = document.getElementById('btnOpenPanel');

// State
let globalShieldEnabled = true;
let siteBypassList = [];
let currentHost = '';
let currentTabId = null;
let tabLookupFailed = false;
let settingsLoaded = false;
let settingsLoadFailed = false;
let shieldSyncPending = false;
let shieldSyncStale = false;

let canvasProtection = true;
let webrtcProtection = true;
let audioProtection = true;
let timezoneProtection = true;
let languageProtection = false;
let hardwareProtection = true;
let fontProtection = true;
let geolocationProtection = false;

const MODULE_SWITCHES = [
  { el: $canvasProtection, key: 'canvasProtection' },
  { el: $webrtcProtection, key: 'webrtcProtection' },
  { el: $audioProtection, key: 'audioProtection' },
  { el: $timezoneProtection, key: 'timezoneProtection' },
  { el: $languageProtection, key: 'languageProtection' },
  { el: $hardwareProtection, key: 'hardwareProtection' },
  { el: $fontProtection, key: 'fontProtection' },
  { el: $geolocationProtection, key: 'geolocationProtection' }
];

// Public suffixes must never become bypass entries. Accepting one would make
// the background build "*://*.com/*" and disable injection on every .com site.
// Keep this list in sync with panel/panel.js.
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

function isPublicSuffixHost(host) {
  const value = String(host || '').trim().toLowerCase();
  if (!value || value === 'localhost') return false;
  if (value.startsWith('[') || value.includes(':')) return false;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(value)) return false;
  if (PUBLIC_SUFFIX_MULTI.has(value)) return true;
  if (value.includes('.')) return false;
  return PUBLIC_SUFFIX_SINGLE.has(value) || /^[a-z]{2}$/.test(value);
}

function normalizeDomain(d) {
  if (!d || typeof d !== 'string') return '';
  let s = d.trim().toLowerCase();
  if (!s) return '';
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
  s = s.split('/')[0].split(':')[0];
  if (!s) return '';
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(s)) {
    return s.split('.').every(part => Number(part) <= 255) ? s : '';
  }
  if (!/^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(s)) return '';
  if (isPublicSuffixHost(s)) return '';
  return s;
}

// 返回与当前 host 匹配的条目:exact = 完全相等,parent = 覆盖当前 host 的父域例外
function findBypassMatch(host, list) {
  if (!host || !Array.isArray(list) || list.length === 0) return { exact: false, parent: '' };
  const h = host.toLowerCase();
  let exact = false;
  let parent = '';
  for (const raw of list) {
    const site = normalizeDomain(raw);
    if (!site) continue;
    if (site === h) {
      exact = true;
    } else if (h.endsWith('.' + site) && site.length > parent.length) {
      parent = site;
    }
  }
  return { exact, parent: exact ? '' : parent };
}

// 清理历史/外部写入的无效条目(含公共后缀),必要时回写,避免后台仍生成 *.com 排除规则。
function sanitizeBypassList(value) {
  const result = [];
  const seen = new Set();
  for (const raw of Array.isArray(value) ? value : []) {
    const site = normalizeDomain(raw);
    if (!site || seen.has(site)) continue;
    seen.add(site);
    result.push(site);
    if (result.length >= 500) break;
  }
  return result;
}

function bypassListNeedsRewrite(rawList, cleaned) {
  if (!Array.isArray(rawList) || rawList.length !== cleaned.length) return true;
  return rawList.some((raw, index) => normalizeDomain(raw) !== cleaned[index]);
}

function updateUI() {
  if ($globalShieldEnabled) {
    $globalShieldEnabled.checked = globalShieldEnabled;
    $globalShieldEnabled.disabled = !settingsLoaded;
  }

  MODULE_SWITCHES.forEach(({ el, key }) => {
    if (!el) return;
    el.disabled = !settingsLoaded;
    switch (key) {
      case 'canvasProtection': el.checked = canvasProtection; break;
      case 'webrtcProtection': el.checked = webrtcProtection; break;
      case 'audioProtection': el.checked = audioProtection; break;
      case 'timezoneProtection': el.checked = timezoneProtection; break;
      case 'languageProtection': el.checked = languageProtection; break;
      case 'hardwareProtection': el.checked = hardwareProtection; break;
      case 'fontProtection': el.checked = fontProtection; break;
      case 'geolocationProtection': el.checked = geolocationProtection; break;
    }
  });

  if ($modulesList) {
    $modulesList.classList.toggle('is-disabled', !globalShieldEnabled || !settingsLoaded);
  }

  if (!settingsLoaded) {
    if ($statusBadge) $statusBadge.className = 'status-badge status-disabled';
    if ($statusText) $statusText.textContent = settingsLoadFailed ? '设置读取失败' : '正在加载';
    if ($siteDomain) {
      $siteDomain.textContent = settingsLoadFailed ? '无法读取设置' : '正在读取设置…';
    }
    if ($siteStatusText) {
      $siteStatusText.textContent = '—';
      $siteStatusText.className = 'site-status-badge disabled';
    }
    if ($siteBypass) {
      $siteBypass.disabled = true;
      $siteBypass.checked = false;
    }
    if ($siteActionDesc) {
      $siteActionDesc.textContent = settingsLoadFailed ? '请重新打开扩展或刷新页面' : '正在读取设置…';
    }
    return;
  }

  const match = findBypassMatch(currentHost, siteBypassList);
  const bypassed = match.exact || !!match.parent;

  // Status Badge
  if (globalShieldEnabled && shieldSyncPending) {
    if ($statusBadge) $statusBadge.className = 'status-badge status-disabled';
    if ($statusText) $statusText.textContent = '正在恢复防护…';
  } else if (globalShieldEnabled && shieldSyncStale) {
    if ($statusBadge) $statusBadge.className = 'status-badge status-disabled';
    if ($statusText) $statusText.textContent = '已开启，刷新后生效';
  } else if (!globalShieldEnabled) {
    if ($statusBadge) $statusBadge.className = 'status-badge status-disabled';
    if ($statusText) $statusText.textContent = '全局已暂停';
  } else if (bypassed) {
    if ($statusBadge) $statusBadge.className = 'status-badge status-bypassed';
    if ($statusText) $statusText.textContent = '当前网站已暂停';
  } else {
    if ($statusBadge) $statusBadge.className = 'status-badge';
    if ($statusText) $statusText.textContent = '防护中';
  }

  // Site Card
  if (!currentHost) {
    if ($siteDomain) {
      $siteDomain.textContent = tabLookupFailed ? '无法读取当前标签页' : '内置页面或无可用域名';
      $siteDomain.title = $siteDomain.textContent;
    }
    if ($siteStatusText) {
      $siteStatusText.textContent = tabLookupFailed ? '未知' : '无需防护';
      $siteStatusText.className = 'site-status-badge disabled';
    }
    if ($siteBypass) {
      $siteBypass.disabled = true;
      $siteBypass.checked = false;
    }
    if ($siteActionDesc) {
      $siteActionDesc.textContent = tabLookupFailed
        ? '请切换到普通网页后重试'
        : '内置页面无需加入例外';
    }
    return;
  }

  if ($siteDomain) {
    $siteDomain.textContent = currentHost;
    $siteDomain.title = currentHost;
  }

  const parentOnly = !match.exact && !!match.parent;
  if ($siteBypass) {
    $siteBypass.disabled = parentOnly;
    $siteBypass.checked = bypassed;
    $siteBypass.title = parentOnly
      ? `由 ${match.parent} 例外覆盖，请在设置页移除该例外`
      : '对此网站暂停防护';
  }

  if ($siteStatusText) {
    if (!globalShieldEnabled) {
      $siteStatusText.textContent = '全局已暂停';
      $siteStatusText.className = 'site-status-badge disabled';
    } else if (shieldSyncPending) {
      $siteStatusText.textContent = '正在恢复';
      $siteStatusText.className = 'site-status-badge disabled';
    } else if (shieldSyncStale) {
      $siteStatusText.textContent = '刷新后生效';
      $siteStatusText.className = 'site-status-badge disabled';
    } else if (bypassed) {
      $siteStatusText.textContent = '已暂停';
      $siteStatusText.className = 'site-status-badge bypassed';
    } else {
      $siteStatusText.textContent = '受保护';
      $siteStatusText.className = 'site-status-badge';
    }
  }

  if ($siteActionDesc) {
    if (globalShieldEnabled && shieldSyncPending) {
      $siteActionDesc.textContent = '正在等待内容脚本注册…';
    } else if (globalShieldEnabled && shieldSyncStale) {
      $siteActionDesc.textContent = '内容脚本注册未确认，请刷新当前页面';
    } else if (parentOnly) {
      $siteActionDesc.textContent = `由 ${match.parent} 例外覆盖，请在设置页移除父域例外`;
    } else if (match.exact) {
      $siteActionDesc.textContent = '关闭开关可恢复此网站的防护';
    } else {
      $siteActionDesc.textContent = '对此网站暂停防护（加入例外名单）';
    }
  }
}

function setSiteNotice(message) {
  if ($siteActionDesc) $siteActionDesc.textContent = message;
}

function hostMatchesExclude(pattern, host) {
  const match = /^\*:\/\/(?:\*\.)?([^/]+)\/\*$/.exec(String(pattern || ''));
  return !!match && match[1].toLowerCase() === host;
}

// 等待后台把内容脚本注册同步到期望状态,再刷新页面;避免刷新抢在注册更新之前。
// expectedExcluded=true: 宿主应被排除(加入例外);false: 宿主应被覆盖(移出例外/全局开启)。
function waitForContentScriptRegistration(host, expectedExcluded, done, attempt = 0) {
  const scripting = typeof chrome !== 'undefined' ? chrome.scripting : null;
  if (!scripting || typeof scripting.getRegisteredContentScripts !== 'function') {
    setTimeout(() => done(false), 150);
    return;
  }
  try {
    scripting.getRegisteredContentScripts((scripts) => {
      if (chrome.runtime.lastError) {
        setTimeout(() => done(false), 150);
        return;
      }
      const list = Array.isArray(scripts) ? scripts : [];
      const ids = new Set(list.map(script => script && script.id));
      const registered = ids.has('bocchi-engine') && ids.has('bocchi-bridge');
      const excluded = host
        ? list.some(script =>
          script && Array.isArray(script.excludeMatches) &&
          script.excludeMatches.some(pattern => hostMatchesExclude(pattern, host)))
        : false;
      const ready = registered && excluded === expectedExcluded;
      if (ready || attempt >= 30) {
        done(ready);
        return;
      }
      setTimeout(() => waitForContentScriptRegistration(host, expectedExcluded, done, attempt + 1), 100);
    });
  } catch (_) {
    setTimeout(() => done(false), 150);
  }
}

// 站点例外通过脚本注册生效:保存后刷新当前 http(s) 标签页,确保立即切换注入状态
function refreshCurrentTab() {
  if (currentTabId === null || typeof chrome === 'undefined' || !chrome.tabs || typeof chrome.tabs.reload !== 'function') {
    setSiteNotice('已保存，刷新当前页面后生效');
    return;
  }
  try {
    chrome.tabs.reload(currentTabId, {}, () => {
      if (chrome.runtime.lastError) {
        setSiteNotice('已保存，刷新当前页面后生效');
      }
    });
  } catch (_) {
    setSiteNotice('已保存，刷新当前页面后生效');
  }
}

// Master switch event
if ($globalShieldEnabled) {
  $globalShieldEnabled.addEventListener('change', () => {
    if (!settingsLoaded) {
      $globalShieldEnabled.checked = globalShieldEnabled;
      return;
    }
    const nextEnabled = $globalShieldEnabled.checked;
    const previous = globalShieldEnabled;
    globalShieldEnabled = nextEnabled;

    if (!nextEnabled) {
      shieldSyncPending = false;
      shieldSyncStale = false;
      updateUI();
      chrome.storage.local.set({ globalShieldEnabled: false }, () => {
        if (chrome.runtime.lastError) {
          globalShieldEnabled = previous;
          updateUI();
          setSiteNotice('保存失败，请重试');
        }
      });
      return;
    }

    // 全局关闭时后台注销了内容脚本。开启后必须等注册恢复,再刷新当前页,
    // 否则 popup 会显示"防护中"而页面实际上仍未注入。
    shieldSyncPending = true;
    shieldSyncStale = false;
    updateUI();
    chrome.storage.local.set({ globalShieldEnabled: true }, () => {
      if (chrome.runtime.lastError) {
        globalShieldEnabled = previous;
        shieldSyncPending = false;
        shieldSyncStale = false;
        updateUI();
        setSiteNotice('保存失败，请重试');
        return;
      }
      if (!currentHost) {
        shieldSyncPending = false;
        updateUI();
        setSiteNotice('已开启，刷新页面后生效');
        return;
      }
      const match = findBypassMatch(currentHost, siteBypassList);
      const expectedExcluded = match.exact || !!match.parent;
      waitForContentScriptRegistration(currentHost, expectedExcluded, (ready) => {
        shieldSyncPending = false;
        shieldSyncStale = !ready;
        updateUI();
        if (!ready) {
          setSiteNotice('已开启，刷新当前页面后生效');
          return;
        }
        if (expectedExcluded) {
          setSiteNotice('已开启；当前网站仍在例外名单中');
          return;
        }
        setSiteNotice('已开启，正在刷新页面…');
        refreshCurrentTab();
      });
    });
  });
}

// Site bypass switch event
if ($siteBypass) {
  $siteBypass.addEventListener('change', () => {
    if (!settingsLoaded) {
      $siteBypass.checked = false;
      return;
    }
    if (!currentHost) return;

    const lower = currentHost.toLowerCase();
    const normalizedHost = normalizeDomain(lower);
    if (!normalizedHost) {
      updateUI();
      setSiteNotice('当前网站是公共后缀，不能加入例外名单');
      return;
    }
    const match = findBypassMatch(lower, siteBypassList);
    if (!match.exact && match.parent) {
      // 父域例外覆盖时开关禁用,不应走到这里
      updateUI();
      return;
    }

    // 只删除与当前 host 完全相等的条目,父域例外必须去设置页移除
    const previousList = siteBypassList;
    let nextList = siteBypassList.filter(s => {
      const site = normalizeDomain(s);
      return site && site !== lower;
    });

    if ($siteBypass.checked) nextList.push(normalizedHost);

    siteBypassList = nextList;
    updateUI();
    chrome.storage.local.set({ siteBypassList: nextList }, () => {
      if (chrome.runtime.lastError) {
        siteBypassList = previousList;
        updateUI();
        setSiteNotice('保存失败，请重试');
        return;
      }
      const nextMatch = findBypassMatch(normalizedHost, nextList);
      const expectedExcluded = nextMatch.exact || !!nextMatch.parent;
      setSiteNotice('已保存，正在刷新页面…');
      waitForContentScriptRegistration(normalizedHost, expectedExcluded, (ready) => {
        if (!ready) setSiteNotice('已保存，刷新当前页面后生效');
        refreshCurrentTab();
      });
    });
  });
}

// Module switches events
MODULE_SWITCHES.forEach(({ el, key }) => {
  if (!el) return;
  el.addEventListener('change', () => {
    if (!settingsLoaded) {
      updateUI();
      return;
    }
    const val = el.checked;
    switch (key) {
      case 'canvasProtection': canvasProtection = val; break;
      case 'webrtcProtection': webrtcProtection = val; break;
      case 'audioProtection': audioProtection = val; break;
      case 'timezoneProtection': timezoneProtection = val; break;
      case 'languageProtection': languageProtection = val; break;
      case 'hardwareProtection': hardwareProtection = val; break;
      case 'fontProtection': fontProtection = val; break;
      case 'geolocationProtection': geolocationProtection = val; break;
    }
    chrome.storage.local.set({ [key]: val });
    updateUI();
  });
});

// Open Panel button
if ($btnOpenPanel) {
  $btnOpenPanel.addEventListener('click', () => {
    if (chrome.tabs && chrome.tabs.create) {
      chrome.tabs.create({ url: chrome.runtime.getURL('panel/panel.html') });
    } else if (chrome.runtime && chrome.runtime.openOptionsPage) {
      chrome.runtime.openOptionsPage();
    }
  });
}

// Listen for storage changes from other contexts
if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.onChanged) {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !settingsLoaded) return;
    let needsUpdate = false;

    if (changes.globalShieldEnabled) {
      globalShieldEnabled = changes.globalShieldEnabled.newValue !== false;
      if (!globalShieldEnabled) {
        shieldSyncPending = false;
        shieldSyncStale = false;
      }
      needsUpdate = true;
    }
    if (changes.siteBypassList) {
      const rawList = Array.isArray(changes.siteBypassList.newValue) ? changes.siteBypassList.newValue : [];
      const cleaned = sanitizeBypassList(rawList);
      siteBypassList = cleaned;
      if (bypassListNeedsRewrite(rawList, cleaned)) {
        chrome.storage.local.set({ siteBypassList: cleaned }, () => { void chrome.runtime.lastError; });
      }
      needsUpdate = true;
    }
    const moduleChanges = {
      canvasProtection: () => { canvasProtection = changes.canvasProtection.newValue !== false; },
      webrtcProtection: () => { webrtcProtection = changes.webrtcProtection.newValue !== false; },
      audioProtection: () => { audioProtection = changes.audioProtection.newValue !== false; },
      timezoneProtection: () => { timezoneProtection = changes.timezoneProtection.newValue !== false; },
      languageProtection: () => { languageProtection = changes.languageProtection.newValue === true; },
      hardwareProtection: () => { hardwareProtection = changes.hardwareProtection.newValue !== false; },
      fontProtection: () => { fontProtection = changes.fontProtection.newValue !== false; },
      geolocationProtection: () => { geolocationProtection = changes.geolocationProtection.newValue === true; }
    };
    for (const [key, apply] of Object.entries(moduleChanges)) {
      if (!changes[key]) continue;
      apply();
      needsUpdate = true;
    }
    if (changes.theme) {
      applyTheme(changes.theme.newValue);
    }

    if (needsUpdate && settingsLoaded) {
      updateUI();
    }
  });
}

// 主题:与设置页共用 storage.theme(system/dark/light)
const popupThemeMedia = typeof window !== 'undefined' && window.matchMedia
  ? window.matchMedia('(prefers-color-scheme: light)') : null;
let popupThemePref = 'system';

function applyTheme(pref) {
  popupThemePref = ['dark', 'light', 'system'].includes(pref) ? pref : 'system';
  const effective = popupThemePref === 'light' ||
    (popupThemePref === 'system' && popupThemeMedia && popupThemeMedia.matches) ? 'light' : 'dark';
  document.documentElement.dataset.theme = effective;
}
if (popupThemeMedia && popupThemeMedia.addEventListener) {
  popupThemeMedia.addEventListener('change', () => {
    if (popupThemePref === 'system') applyTheme('system');
  });
}

// Initialize popup
function init() {
  const keys = [
    'globalShieldEnabled',
    'siteBypassList',
    'canvasProtection',
    'webrtcProtection',
    'audioProtection',
    'timezoneProtection',
    'languageProtection',
    'hardwareProtection',
    'fontProtection',
    'geolocationProtection',
    'theme'
  ];

  const loadStorage = () => {
    if (typeof chrome === 'undefined' || !chrome.storage || !chrome.storage.local) {
      settingsLoaded = true;
      updateUI();
      return;
    }

    chrome.storage.local.get(keys, (res) => {
      if (chrome.runtime.lastError) {
        settingsLoadFailed = true;
        settingsLoaded = false;
        updateUI();
        return;
      }
      if (res) {
        globalShieldEnabled = res.globalShieldEnabled !== false;
        const storedBypass = Array.isArray(res.siteBypassList) ? res.siteBypassList : [];
        siteBypassList = sanitizeBypassList(storedBypass);
        if (bypassListNeedsRewrite(storedBypass, siteBypassList)) {
          chrome.storage.local.set({ siteBypassList }, () => { void chrome.runtime.lastError; });
        }
        canvasProtection = res.canvasProtection !== false;
        webrtcProtection = res.webrtcProtection !== false;
        audioProtection = res.audioProtection !== false;
        timezoneProtection = res.timezoneProtection !== false;
        languageProtection = res.languageProtection === true;
        hardwareProtection = res.hardwareProtection !== false;
        fontProtection = res.fontProtection !== false;
        geolocationProtection = res.geolocationProtection === true;
        applyTheme(res.theme);
      }
      settingsLoaded = true;
      updateUI();
    });
  };

  updateUI();

  if (typeof chrome !== 'undefined' && chrome.tabs && chrome.tabs.query) {
    try {
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        if (chrome.runtime.lastError) {
          tabLookupFailed = true;
          currentHost = '';
          currentTabId = null;
          loadStorage();
          return;
        }
        const tab = tabs && tabs[0];
        currentTabId = tab && typeof tab.id === 'number' ? tab.id : null;
        const rawUrl = tab && (tab.url || tab.pendingUrl);
        if (rawUrl) {
          try {
            const u = new URL(rawUrl);
            if (u.protocol === 'http:' || u.protocol === 'https:') {
              currentHost = u.hostname.toLowerCase();
            } else {
              currentTabId = null;
            }
          } catch (_) {
            currentHost = '';
            currentTabId = null;
          }
        }
        loadStorage();
      });
      return;
    } catch (_) {
      tabLookupFailed = true;
    }
  }

  loadStorage();
}

init();
