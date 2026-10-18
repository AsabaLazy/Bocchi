'use strict';

// DOM Elements
const $globalShieldEnabled = document.getElementById('globalShieldEnabled');
const $statusBadge = document.getElementById('statusBadge');
const $statusText = document.getElementById('statusText');

const $siteDomain = document.getElementById('siteDomain');
const $siteStatusText = document.getElementById('siteStatusText');
const $siteBypass = document.getElementById('siteBypass');

const $modulesList = document.getElementById('modulesList');
const $canvasProtection = document.getElementById('canvasProtection');
const $webrtcProtection = document.getElementById('webrtcProtection');
const $audioProtection = document.getElementById('audioProtection');
const $timezoneProtection = document.getElementById('timezoneProtection');
const $hardwareProtection = document.getElementById('hardwareProtection');
const $fontProtection = document.getElementById('fontProtection');

const $btnOpenPanel = document.getElementById('btnOpenPanel');

// State
let globalShieldEnabled = true;
let siteBypassList = [];
let currentHost = '';

let canvasProtection = true;
let webrtcProtection = true;
let audioProtection = true;
let timezoneProtection = true;
let hardwareProtection = true;
let fontProtection = true;

const MODULE_SWITCHES = [
  { el: $canvasProtection, key: 'canvasProtection' },
  { el: $webrtcProtection, key: 'webrtcProtection' },
  { el: $audioProtection, key: 'audioProtection' },
  { el: $timezoneProtection, key: 'timezoneProtection' },
  { el: $hardwareProtection, key: 'hardwareProtection' },
  { el: $fontProtection, key: 'fontProtection' }
];

function normalizeDomain(d) {
  if (!d || typeof d !== 'string') return '';
  return d.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^\*\.?/, '').replace(/^\.+/, '').split('/')[0].split(':')[0];
}

function isHostBypassed(host, list) {
  if (!host || !Array.isArray(list) || list.length === 0) return false;
  const h = host.toLowerCase();
  return list.some(site => {
    const s = normalizeDomain(site);
    return s && (h === s || h.endsWith('.' + s));
  });
}

function updateUI() {
  if ($globalShieldEnabled) {
    $globalShieldEnabled.checked = globalShieldEnabled;
  }

  MODULE_SWITCHES.forEach(({ el, key }) => {
    if (!el) return;
    switch (key) {
      case 'canvasProtection': el.checked = canvasProtection; break;
      case 'webrtcProtection': el.checked = webrtcProtection; break;
      case 'audioProtection': el.checked = audioProtection; break;
      case 'timezoneProtection': el.checked = timezoneProtection; break;
      case 'hardwareProtection': el.checked = hardwareProtection; break;
      case 'fontProtection': el.checked = fontProtection; break;
    }
  });

  if ($modulesList) {
    $modulesList.classList.toggle('is-disabled', !globalShieldEnabled);
  }

  const bypassed = isHostBypassed(currentHost, siteBypassList);

  // Status Badge
  if (!globalShieldEnabled) {
    if ($statusBadge) $statusBadge.className = 'status-badge status-disabled';
    if ($statusText) $statusText.textContent = '全局已暂停';
  } else if (bypassed) {
    if ($statusBadge) $statusBadge.className = 'status-badge status-bypassed';
    if ($statusText) $statusText.textContent = '当前站点已旁路';
  } else {
    if ($statusBadge) $statusBadge.className = 'status-badge';
    if ($statusText) $statusText.textContent = '防御中';
  }

  // Site Card
  if (!currentHost) {
    if ($siteDomain) $siteDomain.textContent = '内置页面或无可用域名';
    if ($siteStatusText) {
      $siteStatusText.textContent = '无需防御';
      $siteStatusText.className = 'site-status-badge disabled';
    }
    if ($siteBypass) {
      $siteBypass.disabled = true;
      $siteBypass.checked = false;
    }
  } else {
    if ($siteDomain) {
      $siteDomain.textContent = currentHost;
      $siteDomain.title = currentHost;
    }
    if ($siteBypass) {
      $siteBypass.disabled = false;
      $siteBypass.checked = bypassed;
    }
    if ($siteStatusText) {
      if (!globalShieldEnabled) {
        $siteStatusText.textContent = '全局已暂停';
        $siteStatusText.className = 'site-status-badge disabled';
      } else if (bypassed) {
        $siteStatusText.textContent = '已旁路';
        $siteStatusText.className = 'site-status-badge bypassed';
      } else {
        $siteStatusText.textContent = '受保护';
        $siteStatusText.className = 'site-status-badge';
      }
    }
  }
}

// Master switch event
if ($globalShieldEnabled) {
  $globalShieldEnabled.addEventListener('change', () => {
    globalShieldEnabled = $globalShieldEnabled.checked;
    chrome.storage.local.set({ globalShieldEnabled });
    updateUI();
  });
}

// Site bypass switch event
if ($siteBypass) {
  $siteBypass.addEventListener('change', () => {
    if (!currentHost) return;
    const lower = currentHost.toLowerCase();
    let nextList = siteBypassList.filter(s => {
      const site = normalizeDomain(s);
      if (!site) return false;
      return site !== lower && !lower.endsWith('.' + site);
    });

    if ($siteBypass.checked) {
      nextList.push(lower);
    }

    siteBypassList = nextList;
    chrome.storage.local.set({ siteBypassList });
    updateUI();
  });
}

// Module switches events
MODULE_SWITCHES.forEach(({ el, key }) => {
  if (!el) return;
  el.addEventListener('change', () => {
    const val = el.checked;
    switch (key) {
      case 'canvasProtection': canvasProtection = val; break;
      case 'webrtcProtection': webrtcProtection = val; break;
      case 'audioProtection': audioProtection = val; break;
      case 'timezoneProtection': timezoneProtection = val; break;
      case 'hardwareProtection': hardwareProtection = val; break;
      case 'fontProtection': fontProtection = val; break;
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
    if (area !== 'local') return;
    let needsUpdate = false;

    if (changes.globalShieldEnabled) {
      globalShieldEnabled = changes.globalShieldEnabled.newValue !== false;
      needsUpdate = true;
    }
    if (changes.siteBypassList) {
      siteBypassList = Array.isArray(changes.siteBypassList.newValue) ? changes.siteBypassList.newValue : [];
      needsUpdate = true;
    }
    if (changes.canvasProtection) {
      canvasProtection = changes.canvasProtection.newValue !== false;
      needsUpdate = true;
    }
    if (changes.webrtcProtection) {
      webrtcProtection = changes.webrtcProtection.newValue !== false;
      needsUpdate = true;
    }
    if (changes.audioProtection) {
      audioProtection = changes.audioProtection.newValue !== false;
      needsUpdate = true;
    }
    if (changes.timezoneProtection) {
      timezoneProtection = changes.timezoneProtection.newValue !== false;
      needsUpdate = true;
    }
    if (changes.hardwareProtection) {
      hardwareProtection = changes.hardwareProtection.newValue !== false;
      needsUpdate = true;
    }
    if (changes.fontProtection) {
      fontProtection = changes.fontProtection.newValue !== false;
      needsUpdate = true;
    }

    if (needsUpdate) {
      updateUI();
    }
  });
}

// Initialize popup
function init() {
  const loadStorage = () => {
    if (typeof chrome === 'undefined' || !chrome.storage || !chrome.storage.local) {
      updateUI();
      return;
    }

    const keys = [
      'globalShieldEnabled',
      'siteBypassList',
      'canvasProtection',
      'webrtcProtection',
      'audioProtection',
      'timezoneProtection',
      'hardwareProtection',
      'fontProtection'
    ];

    chrome.storage.local.get(keys, (res) => {
      if (res) {
        globalShieldEnabled = res.globalShieldEnabled !== false;
        siteBypassList = Array.isArray(res.siteBypassList) ? res.siteBypassList : [];
        canvasProtection = res.canvasProtection !== false;
        webrtcProtection = res.webrtcProtection !== false;
        audioProtection = res.audioProtection !== false;
        timezoneProtection = res.timezoneProtection !== false;
        hardwareProtection = res.hardwareProtection !== false;
        fontProtection = res.fontProtection !== false;
      }
      updateUI();
    });
  };

  if (typeof chrome !== 'undefined' && chrome.tabs && chrome.tabs.query) {
    try {
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        const tab = tabs && tabs[0];
        const rawUrl = tab && (tab.url || tab.pendingUrl);
        if (rawUrl) {
          try {
            const u = new URL(rawUrl);
            if (u.protocol === 'http:' || u.protocol === 'https:') {
              currentHost = u.hostname.toLowerCase();
            }
          } catch (_) {}
        }
        loadStorage();
      });
      return;
    } catch (_) {}
  }

  loadStorage();
}

init();
