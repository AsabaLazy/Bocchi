'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

console.log('=== Running Bocchi Privacy Shield Comprehensive Test Suite ===\n');

// 1. Test manifest.json
console.log('[Test 1] Validating manifest.json...');
const manifestPath = path.join(__dirname, '../manifest.json');
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

assert.strictEqual(manifest.manifest_version, 3, 'manifest_version must be 3');
assert(manifest.permissions.includes('declarativeNetRequest'), 'Must have declarativeNetRequest permission');
assert(manifest.permissions.includes('privacy'), 'Must have privacy permission');
assert(manifest.permissions.includes('storage'), 'Must have storage permission');
assert(manifest.host_permissions && manifest.host_permissions.includes('<all_urls>'), 'Must have <all_urls> host permission');
assert.strictEqual(manifest.background.service_worker, 'background/service_worker.js', 'Service worker path mismatch');
assert.strictEqual(manifest.declarative_net_request.rule_resources[0].path, 'rules/cyt_rules.json', 'DNR rules path mismatch');
assert.strictEqual(manifest.content_scripts[0].world, 'MAIN', 'Content script must run in MAIN world');
assert.strictEqual(manifest.content_scripts[0].run_at, 'document_start', 'Content script must run at document_start');
assert.strictEqual(manifest.content_scripts[0].all_frames, true, 'Content script must apply to all frames');
assert.strictEqual(manifest.content_scripts[0].match_about_blank, true, 'Content script must match about:blank');
assert.strictEqual(manifest.web_accessible_resources, undefined, 'Must NOT declare web_accessible_resources (anti-fingerprinting)');
assert(manifest.content_scripts.some(cs => cs.js.includes('content/bridge.js')), 'Must declare content/bridge.js in content_scripts');
console.log('✓ manifest.json is fully valid and compliant.\n');

// 2. Test rules/cyt_rules.json
console.log('[Test 2] Validating rules/cyt_rules.json...');
const rulesPath = path.join(__dirname, '../rules/cyt_rules.json');
const rules = JSON.parse(fs.readFileSync(rulesPath, 'utf8'));

assert(Array.isArray(rules), 'cyt_rules.json must be an array');
assert(rules.length >= 4, 'Must have at least 4 rules');

// Rule 1: block trackersimulator.org
const rule1 = rules.find(r => r.condition.urlFilter === '||trackersimulator.org');
assert(rule1 && rule1.action.type === 'block', 'Rule 1 must block trackersimulator.org');

// Rule 2: block eviltracker.net
const rule2 = rules.find(r => r.condition.urlFilter === '||eviltracker.net');
assert(rule2 && rule2.action.type === 'block', 'Rule 2 must block eviltracker.net');

// Rule 3: allow do-not-tracker.org with higher priority
const rule3 = rules.find(r => r.condition.urlFilter === '||do-not-tracker.org');
assert(rule3 && rule3.action.type === 'allow' && rule3.priority > rule1.priority, 'Rule 3 must allow do-not-tracker.org with higher priority');

// Rule 4: modifyHeaders for DNT, Sec-GPC, Accept-Language, Sec-CH-UA-Platform, and User-Agent
const rule4 = rules.find(r => r.action.type === 'modifyHeaders');
assert(rule4, 'Must have modifyHeaders rule');
const dntHeader = rule4.action.requestHeaders.find(h => h.header === 'DNT');
const gpcHeader = rule4.action.requestHeaders.find(h => h.header === 'Sec-GPC');
const langHeader = rule4.action.requestHeaders.find(h => h.header === 'Accept-Language');
const uaHeader = rule4.action.requestHeaders.find(h => h.header === 'User-Agent');
const platVerHeader = rule4.action.requestHeaders.find(h => h.header === 'Sec-CH-UA-Platform-Version');
const mobileHeader = rule4.action.requestHeaders.find(h => h.header === 'Sec-CH-UA-Mobile');
assert(dntHeader && dntHeader.value === '1', 'DNT header must be set to 1');
assert(gpcHeader && gpcHeader.value === '1', 'Sec-GPC header must be set to 1');
assert(langHeader && langHeader.value === 'en-US,en;q=0.9', 'Accept-Language header must be set to en-US,en;q=0.9');
assert(uaHeader && uaHeader.value.includes('Linux x86_64'), 'User-Agent header must spoof Linux x86_64');
assert(platVerHeader && platVerHeader.value === '""', 'Sec-CH-UA-Platform-Version header must be empty string on Linux');
assert(mobileHeader && mobileHeader.value === '?0', 'Sec-CH-UA-Mobile header must be "?0"');
console.log('✓ rules/cyt_rules.json is fully valid and compliant.\n');

// 3. Test background/service_worker.js
console.log('[Test 3] Validating background/service_worker.js...');
const swPath = path.join(__dirname, '../background/service_worker.js');
const swCode = fs.readFileSync(swPath, 'utf8');

let policySet = null;
let storageData = {};
let mockFetchReturn = null;
let mockFetchError = false;
const installedListeners = [];
const startupListeners = [];

const mockChrome = {
  privacy: {
    network: {
      webRTCIPHandlingPolicy: {
        set(obj, cb) {
          policySet = obj.value;
          if (cb) cb();
          return Promise.resolve();
        }
      }
    }
  },
  storage: {
    local: {
      get(keys, cb) {
        if (cb) { cb(storageData); return; }
        return Promise.resolve(storageData);
      },
      set(obj, cb) {
        Object.assign(storageData, obj);
        if (cb) { cb(); return; }
        return Promise.resolve();
      }
    }
  },
  runtime: {
    lastError: null,
    onInstalled: { addListener(fn) { installedListeners.push(fn); } },
    onStartup: { addListener(fn) { startupListeners.push(fn); } },
    onMessage: { addListener(fn) {} }
  },
  declarativeNetRequest: {
    updateDynamicRules(options, cb) {
      if (options.addRules) {
        mockChrome._dynamicRules = options.addRules;
      }
      if (cb) cb();
      return Promise.resolve();
    }
  }
};

let mockFetchHandler = null;
const mockFetch = async function(url) {
  if (mockFetchError) {
    throw new Error('Network error');
  }
  if (mockFetchHandler) {
    return mockFetchHandler(url);
  }
  return {
    ok: true,
    json: async () => mockFetchReturn || { timezone: { id: 'America/Los_Angeles' } }
  };
};

const swModule = { exports: {} };
const swContext = vm.createContext({
  chrome: mockChrome,
  console: console,
  fetch: mockFetch,
  module: swModule,
  exports: swModule.exports
});
vm.runInContext(swCode, swContext);

assert.strictEqual(policySet, 'disable_non_proxied_udp', 'Service worker must set webRTCIPHandlingPolicy to disable_non_proxied_udp');
assert.strictEqual(installedListeners.length, 1, 'Service worker must register onInstalled listener');
assert.strictEqual(startupListeners.length, 1, 'Service worker must register onStartup listener');

(async () => {
  const { fetchEgressTimezone, syncTimezone } = swModule.exports;
  assert(typeof fetchEgressTimezone === 'function', 'fetchEgressTimezone must be a function');
  assert(typeof syncTimezone === 'function', 'syncTimezone must be a function');

  // Successful GeoIP fetch
  mockFetchError = false;
  mockFetchReturn = { timezone: { id: 'America/Chicago' } };
  const detectedTz = await fetchEgressTimezone();
  assert.strictEqual(detectedTz, 'America/Chicago', 'fetchEgressTimezone should return detected timezone');

  // Fallback to geojs.io when ipwho.is fails
  mockFetchError = false;
  mockFetchHandler = async (url) => {
    if (url.includes('ipwho.is')) throw new Error('ipwho failed');
    if (url.includes('geojs.io')) return { ok: true, json: async () => ({ timezone: 'America/Phoenix' }) };
    return { ok: true, json: async () => ({ timezone: 'America/Los_Angeles' }) };
  };
  const geojsTz = await fetchEgressTimezone();
  assert.strictEqual(geojsTz, 'America/Phoenix', 'fetchEgressTimezone should fallback to geojs.io when ipwho.is fails');
  mockFetchHandler = null;

  // Fallback on all network errors
  mockFetchError = true;
  const fallbackTz = await fetchEgressTimezone();
  assert.strictEqual(fallbackTz, 'America/Los_Angeles', 'fetchEgressTimezone should fallback to America/Los_Angeles on error');

  // syncTimezone stores in storage
  mockFetchError = false;
  mockFetchReturn = { timezone: { id: 'America/Denver' } };
  await syncTimezone();
  // syncUserAgentRule updates dynamic DNR rule 1001 with Linux User-Agent
  const { syncUserAgentRule } = swModule.exports;
  assert(typeof syncUserAgentRule === 'function', 'syncUserAgentRule must be a function');
  await syncUserAgentRule();
  assert(mockChrome._dynamicRules && mockChrome._dynamicRules.length > 0, 'syncUserAgentRule must register dynamic rules');
  const dnrRule = mockChrome._dynamicRules.find(r => r.id === 1001);
  assert(dnrRule, 'Dynamic rule 1001 must exist');
  assert(dnrRule.action.requestHeaders.some(h => h.header === 'User-Agent' && h.value.includes('Linux x86_64')), 'Rule 1001 must set Linux x86_64 UA');
})();

// Test content/bridge.js isolated world bridge
console.log('Validating content/bridge.js isolated world bridge...');
const bridgePath = path.join(__dirname, '../content/bridge.js');
const bridgeCode = fs.readFileSync(bridgePath, 'utf8');

const dispatchedBridgeEvents = [];
let bridgeStorageChangedListener = null;
const bridgeMockChrome = {
  storage: {
    local: {
      get(keys, cb) {
        cb({ targetTimezone: 'America/New_York' });
      }
    },
    onChanged: {
      addListener(fn) {
        bridgeStorageChangedListener = fn;
      }
    }
  }
};
let bridgePostMessageCalled = false;
const bridgeMockDoc = {
  dispatchEvent(evt) {
    dispatchedBridgeEvents.push(evt);
  }
};
const bridgeMockWin = {
  chrome: bridgeMockChrome,
  document: bridgeMockDoc,
  CustomEvent: class CustomEvent {
    constructor(type, init) {
      this.type = type;
      this.detail = init ? init.detail : {};
    }
  },
  postMessage() {
    bridgePostMessageCalled = true;
  }
};
bridgeMockWin.window = bridgeMockWin;
vm.runInContext(bridgeCode, vm.createContext(bridgeMockWin));

const tzEvt = dispatchedBridgeEvents.find(e => e.type === '__bocchi_tz_sync__');
assert(tzEvt, 'bridge.js must dispatch initial timezone sync event');
assert.strictEqual(tzEvt.detail.timezone, 'America/New_York');

const fontEvt = dispatchedBridgeEvents.find(e => e.type === '__bocchi_fonts_sync__');
assert(fontEvt, 'bridge.js must dispatch initial font sync event');
assert.strictEqual(fontEvt.detail.blockBuiltin, true);
assert.strictEqual(bridgePostMessageCalled, false, 'bridge.js must never call postMessage');

if (bridgeStorageChangedListener) {
  bridgeStorageChangedListener({ targetTimezone: { newValue: 'Asia/Tokyo' } }, 'local');
  const latestTz = dispatchedBridgeEvents[dispatchedBridgeEvents.length - 1];
  assert.strictEqual(latestTz.type, '__bocchi_tz_sync__');
  assert.strictEqual(latestTz.detail.timezone, 'Asia/Tokyo');

  bridgeStorageChangedListener({ customHiddenFonts: { newValue: ['CustomFont'] } }, 'local');
  const latestFont = dispatchedBridgeEvents[dispatchedBridgeEvents.length - 1];
  assert.strictEqual(latestFont.type, '__bocchi_fonts_sync__');
}
assert.strictEqual(bridgePostMessageCalled, false, 'bridge.js must never call postMessage on storage update');
console.log('✓ content/bridge.js isolated world event synchronization verified.\n');

// 4. Test content/stealth_engine.js in simulated browser context
console.log('[Test 4] Validating content/stealth_engine.js in simulated browser context...');
const stealthCode = fs.readFileSync(path.join(__dirname, '../content/stealth_engine.js'), 'utf8');

function createMockWindow(hostname, platform = 'Linux x86_64') {
  const win = {};

  // Builtin globals
  win.Function = Function;
  win.Date = Date;
  win.Intl = Intl;

  // Window references
  win.window = win;
  win.top = win;
  win.location = { hostname: hostname };
  class FontFace {
    constructor(family, source, descriptors) {
      this.family = family;
      this.source = source;
      this.status = 'unloaded';
    }
    load() {
      this.status = 'loaded';
      return Promise.resolve(this);
    }
  }
  win.FontFace = FontFace;
  win.DOMException = globalThis.DOMException || class DOMException extends Error {
    constructor(msg, name) {
      super(msg);
      this.name = name || 'DOMException';
    }
  };

  class FontFaceSet {
    check(font, text) {
      return true;
    }
    load(font, text) {
      return Promise.resolve([{ family: font }]);
    }
  }
  win.FontFaceSet = FontFaceSet;
  win.document = {
    referrer: '',
    createElement(tag) {
      if (tag === 'canvas') return new win.HTMLCanvasElement();
      if (tag === 'iframe') return new win.HTMLIFrameElement();
      return { tagName: tag.toUpperCase() };
    },
    fonts: new FontFaceSet()
  };

  win.queryLocalFonts = function() {
    return Promise.resolve([
      { family: 'Arial', fullName: 'Arial Regular', postscriptName: 'ArialMT' },
      { family: 'SimSun', fullName: 'SimSun Regular', postscriptName: 'SimSun' },
      { family: 'Microsoft YaHei', fullName: 'Microsoft YaHei', postscriptName: 'MicrosoftYaHei' },
      { family: 'Times New Roman', fullName: 'Times New Roman', postscriptName: 'TimesNewRomanPSMT' }
    ]);
  };

  // CSSStyleDeclaration and getComputedStyle
  class CSSStyleDeclaration {
    constructor() {
      this._props = {};
    }
    getPropertyValue(prop) {
      return this._props[prop] || '';
    }
    setProperty(prop, val) {
      this._props[prop] = val;
    }
    get fontFamily() {
      return this.getPropertyValue('font-family');
    }
    set fontFamily(v) {
      this.setProperty('font-family', v);
    }
    get font() {
      return this.getPropertyValue('font');
    }
    set font(v) {
      this.setProperty('font', v);
    }
  }
  win.CSSStyleDeclaration = CSSStyleDeclaration;

  win.getComputedStyle = function(el) {
    const s = new CSSStyleDeclaration();
    const ff = (el && el._computedFontFamily) || (el && el.style && el.style.fontFamily) || 'sans-serif';
    s.setProperty('font-family', ff);
    return s;
  };

  // Event listeners on window and document
  const winListeners = {};
  win.addEventListener = function(type, fn, opts) {
    if (!winListeners[type]) winListeners[type] = [];
    winListeners[type].push(fn);
  };
  win.removeEventListener = function(type, fn) {
    if (winListeners[type]) winListeners[type] = winListeners[type].filter(f => f !== fn);
  };
  win.dispatchEvent = function(event) {
    if (winListeners[event.type]) {
      for (const fn of winListeners[event.type]) fn.call(win, event);
    }
  };
  win.postMessage = function(data, origin) {
    win.dispatchEvent({ type: 'message', data, source: win, origin: '*' });
  };

  win.speechSynthesis = {
    getVoices: () => []
  };
  win.SpeechSynthesisVoice = function() {};

  const docListeners = {};
  win.document.addEventListener = function(type, fn, opts) {
    if (!docListeners[type]) docListeners[type] = [];
    docListeners[type].push(fn);
  };
  win.document.removeEventListener = function(type, fn) {
    if (docListeners[type]) docListeners[type] = docListeners[type].filter(f => f !== fn);
  };
  win.document.dispatchEvent = function(event) {
    if (docListeners[event.type]) {
      for (const fn of docListeners[event.type]) fn.call(win.document, event);
    }
  };

  // DOMRect
  class DOMRect {
    constructor(x = 0, y = 0, width = 0, height = 0) {
      this.x = x;
      this.y = y;
      this.width = width;
      this.height = height;
      this.top = y;
      this.left = x;
      this.right = x + width;
      this.bottom = y + height;
    }
  }
  win.DOMRect = DOMRect;

  // DOM Elements
  class Node {
    appendChild(child) {
      return child;
    }
    insertBefore(child, ref) {
      return child;
    }
  }
  win.Node = Node;

  class Element extends Node {
    getBoundingClientRect() {
      let w = 100;
      const ff = (this.style && (this.style.fontFamily || this.style.font)) || this._computedFontFamily;
      if (ff && (ff.includes('SimSun') || ff.includes('SimHei'))) {
        w = 180; // Extended width under SimSun
      }
      return new win.DOMRect(10, 20, w, 50);
    }
    getClientRects() {
      return [this.getBoundingClientRect()];
    }
  }
  win.Element = Element;

  class HTMLElement extends Element {
    constructor() {
      super();
      this._offsetWidth = 150.33;
      this._offsetHeight = 75.88;
      this.style = {
        fontFamily: '',
        font: ''
      };
      this._computedFontFamily = '';
    }
  }
  Object.defineProperty(HTMLElement.prototype, 'offsetWidth', {
    get() {
      const ff = (this.style && this.style.fontFamily) || this._computedFontFamily;
      if (ff && (ff.includes('SimSun') || ff.includes('SimHei'))) {
        return 220; // Chinese font dimension
      }
      return this._offsetWidth || 150;
    },
    configurable: true,
    enumerable: true
  });
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
    get() {
      const ff = (this.style && this.style.fontFamily) || this._computedFontFamily;
      if (ff && (ff.includes('SimSun') || ff.includes('SimHei'))) {
        return 110; // Chinese font dimension
      }
      return this._offsetHeight || 75;
    },
    configurable: true,
    enumerable: true
  });
  win.HTMLElement = HTMLElement;

  class HTMLIFrameElement extends HTMLElement {
    constructor() {
      super();
      this.tagName = 'IFRAME';
      this._contentWindow = createMockWindow('about:blank', platform);
      this._contentWindow.top = win;
    }
    get contentWindow() {
      return this._contentWindow;
    }
    get contentDocument() {
      return this._contentWindow.document;
    }
  }
  win.HTMLIFrameElement = HTMLIFrameElement;
  win.HTMLFrameElement = HTMLIFrameElement;

  // Blob & URL mock
  win.Blob = class Blob {
    constructor(parts, options) {
      this.parts = parts;
      this.options = options;
      this.content = parts.join('');
    }
  };

  class MockURL {
    constructor(url, base) {
      this.href = (base && !url.startsWith('http') && !url.startsWith('blob:')) ? (base + '/' + url) : url;
    }
    static createObjectURL(blob) {
      const id = 'blob:http://' + (hostname || 'example.com') + '/' + Math.random().toString(36).slice(2);
      MockURL._created = MockURL._created || new Map();
      MockURL._created.set(id, blob);
      return id;
    }
  }
  win.URL = MockURL;

  // Range
  class Range {
    constructor() {
      this.commonAncestorContainer = null;
      this.startContainer = null;
      this.startOffset = 0;
      this.endContainer = null;
      this.endOffset = 0;
    }
    selectNode(node) {
      this.startContainer = node.parentElement || node;
      this.commonAncestorContainer = node.parentElement || node;
      this.startOffset = 0;
      if (node.parentElement && !node.parentElement.childNodes) {
        node.parentElement.childNodes = [node];
      }
    }
    selectNodeContents(node) {
      this.commonAncestorContainer = node;
      this.startContainer = node;
      this.startOffset = 0;
    }
    getBoundingClientRect() {
      let node = this.commonAncestorContainer || this.startContainer;
      while (node && node.nodeType !== 1) node = node.parentElement;
      const ff = (node && node.style && (node.style.fontFamily || node.style.font)) || (node && node._computedFontFamily);
      const w = (ff && (ff.includes('SimSun') || ff.includes('SimHei'))) ? 180 : 100;
      return new win.DOMRect(0, 0, w, 20);
    }
    getClientRects() {
      return [this.getBoundingClientRect()];
    }
  }
  win.Range = Range;
  win.document.createRange = () => new Range();

  // SVG Elements
  class SVGElement extends Element {
    constructor() {
      super();
      this._attrs = {};
      this.style = { fontFamily: '', font: '' };
    }
    getAttribute(name) {
      return this._attrs[name] !== undefined ? this._attrs[name] : null;
    }
    setAttribute(name, val) {
      this._attrs[name] = String(val);
    }
    hasAttribute(name) {
      return this._attrs[name] !== undefined;
    }
  }
  win.SVGElement = SVGElement;

  class SVGGraphicsElement extends SVGElement {
    getBBox() {
      const ff = this.getAttribute('font-family') || (this.style && this.style.fontFamily);
      const w = (ff && (ff.includes('SimSun') || ff.includes('SimHei'))) ? 180 : 100;
      return new win.DOMRect(0, 0, w, 20);
    }
  }
  win.SVGGraphicsElement = SVGGraphicsElement;

  class SVGTextContentElement extends SVGGraphicsElement {
    getComputedTextLength() {
      const ff = this.getAttribute('font-family') || (this.style && this.style.fontFamily);
      return (ff && (ff.includes('SimSun') || ff.includes('SimHei'))) ? 180 : 100;
    }
    getSubStringLength() {
      return this.getComputedTextLength();
    }
    getExtentOfChar() {
      return new win.DOMRect(0, 0, 10, 10);
    }
  }
  win.SVGTextContentElement = SVGTextContentElement;

  // Worker & SharedWorker
  class RealWorker {
    constructor(scriptURL, options) {
      if (arguments.length === 0) {
        throw new TypeError("Failed to construct 'Worker': 1 argument required, but only 0 present.");
      }
      this.scriptURL = scriptURL;
      this.options = options;
      this._listeners = {};
      RealWorker.lastInstance = this;
    }
    addEventListener(type, fn) {
      this._listeners[type] = this._listeners[type] || [];
      this._listeners[type].push(fn);
    }
    removeEventListener(type, fn) {
      if (this._listeners[type]) {
        this._listeners[type] = this._listeners[type].filter(f => f !== fn);
      }
    }
    dispatchEvent(ev) {
      if (this._listeners[ev.type]) {
        for (const fn of this._listeners[ev.type]) fn.call(this, ev);
      }
      if (this['on' + ev.type]) {
        this['on' + ev.type].call(this, ev);
      }
    }
    postMessage(msg) {}
    terminate() {}
  }
  win.Worker = RealWorker;

  class RealSharedWorker {
    constructor(scriptURL, options) {
      if (arguments.length === 0) {
        throw new TypeError("Failed to construct 'SharedWorker': 1 argument required, but only 0 present.");
      }
      this.scriptURL = scriptURL;
      this.options = options;
      this.port = {
        _listeners: {},
        addEventListener(type, fn) {
          this._listeners[type] = this._listeners[type] || [];
          this._listeners[type].push(fn);
        },
        removeEventListener(type, fn) {
          if (this._listeners[type]) {
            this._listeners[type] = this._listeners[type].filter(f => f !== fn);
          }
        },
        dispatchEvent(ev) {
          if (this._listeners[ev.type]) {
            for (const fn of this._listeners[ev.type]) fn.call(this, ev);
          }
          if (this['on' + ev.type]) {
            this['on' + ev.type].call(this, ev);
          }
        },
        postMessage() {}
      };
      RealSharedWorker.lastInstance = this;
    }
  }
  win.SharedWorker = RealSharedWorker;

  // Canvas Classes
  class CanvasRenderingContext2D {
    constructor(canvas) {
      this.canvas = canvas;
      this.font = '10px sans-serif';
      this._pixels = new Uint8ClampedArray(4 * 10 * 10);
      for (let i = 0; i < this._pixels.length; i += 4) {
        this._pixels[i] = 100;     // R
        this._pixels[i + 1] = 150; // G
        this._pixels[i + 2] = 200; // B
        this._pixels[i + 3] = 255; // A
      }
    }
    getImageData(sx, sy, sw, sh) {
      return { data: new Uint8ClampedArray(this._pixels.slice(0, sw * sh * 4)) };
    }
    putImageData(imgData, dx, dy) {
      for (let i = 0; i < imgData.data.length; i++) {
        this._pixels[i] = imgData.data[i];
      }
    }
    drawImage() {}
    measureText(text) {
      const font = this.font || '10px sans-serif';
      let width = (text ? text.length : 0) * 10;
      if (font.includes('SimSun') || font.includes('SimHei')) {
        width += 70; // Chinese font extra dimension
      }
      return { width, actualBoundingBoxAscent: 10, actualBoundingBoxDescent: 2 };
    }
  }
  win.CanvasRenderingContext2D = CanvasRenderingContext2D;

  class HTMLCanvasElement extends HTMLElement {
    constructor() {
      super();
      this.width = 10;
      this.height = 10;
      this._ctx2d = null;
    }
    getContext(type) {
      if (type === '2d') {
        if (!this._ctx2d) this._ctx2d = new win.CanvasRenderingContext2D(this);
        return this._ctx2d;
      }
      return null;
    }
    toDataURL(type, quality) {
      const r = this._ctx2d ? this._ctx2d._pixels[0] : 0;
      const a = this._ctx2d ? this._ctx2d._pixels[3] : 0;
      return `data:image/png;base64,mockPngR${r}A${a}`;
    }
    toBlob(callback, type, quality) {
      const r = this._ctx2d ? this._ctx2d._pixels[0] : 0;
      const a = this._ctx2d ? this._ctx2d._pixels[3] : 0;
      setTimeout(() => callback({ size: 100, type: 'image/png', r, a }), 0);
    }
  }
  win.HTMLCanvasElement = HTMLCanvasElement;

  // WebGL Classes
  class WebGLRenderingContext {
    getParameter(param) {
      if (param === 37445) return 'Mesa/X.org';
      if (param === 37446) return 'llvmpipe (LLVM 12.0.0, 256 bits)';
      return null;
    }
    getExtension(name) {
      return null;
    }
    getSupportedExtensions() {
      return ['OES_texture_float'];
    }
    readPixels(x, y, w, h, format, type, pixels) {
      pixels[0] = 50;
      pixels[1] = 60;
      pixels[2] = 70;
      pixels[3] = 255;
    }
  }
  win.WebGLRenderingContext = WebGLRenderingContext;

  class WebGL2RenderingContext extends WebGLRenderingContext {}
  win.WebGL2RenderingContext = WebGL2RenderingContext;

  // AudioBuffer
  class AudioBuffer {
    constructor(length = 5000) {
      this.length = length;
      this._channel0 = new Float32Array(length);
      for (let i = 0; i < length; i++) {
        this._channel0[i] = Math.sin(i / 100);
      }
    }
    getChannelData(c) {
      return this._channel0;
    }
    copyFromChannel(dest, c, offset) {
      dest.set(this._channel0.subarray(offset || 0));
    }
  }
  win.AudioBuffer = AudioBuffer;

  // MediaDeviceInfo
  class MediaDeviceInfo {
    constructor(kind = 'audioinput', label = 'Realtek Audio Mic', id = 'mic-123') {
      this.deviceId = id;
      this.groupId = 'group-1';
      this.kind = kind;
      this.label = label;
    }
  }
  win.MediaDeviceInfo = MediaDeviceInfo;

  // RTCPeerConnection
  class RTCSessionDescription {
    constructor(init) {
      this.type = init.type;
      this.sdp = init.sdp;
    }
  }
  win.RTCSessionDescription = RTCSessionDescription;

  class RTCPeerConnection {
    constructor() {
      this.listeners = {};
      this._onicecandidate = null;
      this._localDescription = null;
    }
    createOffer(options) {
      const mockSDP = [
        'v=0',
        'o=- 12345 2 IN IP4 127.0.0.1',
        's=-',
        'a=candidate:1 1 UDP 2122260223 192.168.1.100 54321 typ host generation 0',
        'a=candidate:2 1 UDP 2122260223 10.0.0.5 54321 typ host generation 0',
        'a=candidate:3 1 UDP 1686052607 203.0.113.1 54321 typ srflx raddr 192.168.1.100 rport 54321',
        'a=end-of-candidates'
      ].join('\r\n');
      const desc = new win.RTCSessionDescription({ type: 'offer', sdp: mockSDP });
      this._localDescription = desc;
      return Promise.resolve(desc);
    }
    createAnswer(options) {
      return this.createOffer(options);
    }
    setLocalDescription(desc) {
      if (desc) this._localDescription = desc;
      return Promise.resolve();
    }
    get localDescription() { return this._localDescription; }
    get currentLocalDescription() { return this._localDescription; }
    get pendingLocalDescription() { return this._localDescription; }

    addEventListener(type, listener) {
      if (!this.listeners[type]) this.listeners[type] = [];
      this.listeners[type].push(listener);
    }
    removeEventListener(type, listener) {
      if (!this.listeners[type]) return;
      const idx = this.listeners[type].indexOf(listener);
      if (idx !== -1) this.listeners[type].splice(idx, 1);
    }
    dispatchEvent(event) {
      if (this.listeners[event.type]) {
        for (const l of this.listeners[event.type]) l.call(this, event);
      }
      if (event.type === 'icecandidate' && this._onicecandidate) {
        this._onicecandidate(event);
      }
    }
    get onicecandidate() { return this._onicecandidate; }
    set onicecandidate(fn) { this._onicecandidate = fn; }
  }
  win.RTCPeerConnection = RTCPeerConnection;

  // Navigator
  class Navigator {
    constructor() {
      this.platform = platform;
      this.language = 'zh-CN';
      this.languages = ['zh-CN', 'zh'];
      this.webdriver = true;
      this.doNotTrack = null;
      this.globalPrivacyControl = false;
      this.hardwareConcurrency = 16;
      this.deviceMemory = 32;
      this.permissions = {
        query(param) {
          return Promise.resolve({ state: 'denied' });
        }
      };
      this.mediaDevices = new win.MediaDevices();
    }
  }
  class MediaDevices {
    enumerateDevices() {
      return Promise.resolve([
        new win.MediaDeviceInfo('audioinput', 'Internal Mic', 'mic-abc-123'),
        new win.MediaDeviceInfo('videoinput', 'HD Webcam', 'cam-xyz-456')
      ]);
    }
  }
  win.MediaDevices = MediaDevices;
  win.Navigator = Navigator;
  win.navigator = new Navigator();

  class MemoryInfo {
    get jsHeapSizeLimit() { return 4294967296; }
    get totalJSHeapSize() { return 100000000; }
    get usedJSHeapSize() { return 50000000; }
  }
  win.performance = {
    now: () => Date.now(),
    memory: new MemoryInfo()
  };

  // Plugin
  class Plugin {
    constructor() {
      this.name = 'PDF Viewer';
      this.description = 'Portable Document Format';
      this.filename = 'internal-pdf-viewer';
    }
  }
  win.Plugin = Plugin;
  Object.defineProperty(Plugin.prototype, 'description', {
    get() { return this._desc || 'Portable Document Format'; },
    set(v) { this._desc = v; },
    configurable: true,
    enumerable: true
  });

  // Screen mock
  class Screen {
    constructor() {
      this.width = 1920;
      this.height = 1080;
      this.availWidth = 1920;
      this.availHeight = 1080;
    }
  }
  win.Screen = Screen;
  win.screen = new Screen();

  // WebGPU mock
  class GPU {
    requestAdapter() {
      const adapterInfo = {
        vendor: 'linux-driver',
        architecture: 'vulkan',
        device: 'RTX 3060',
        description: 'Linux Vulkan'
      };
      return Promise.resolve({
        info: Object.assign({}, adapterInfo),
        requestAdapterInfo() {
          return Promise.resolve(Object.assign({}, adapterInfo));
        }
      });
    }
  }
  win.GPU = GPU;
  win.navigator.gpu = new GPU();

  // MessageEvent mock
  win.MessageEvent = class MessageEvent {
    constructor(type, init) {
      this.type = type;
      this.data = init && init.data;
      this.origin = (init && init.origin) || '';
      this.lastEventId = (init && init.lastEventId) || '';
      this.source = (init && init.source) || null;
      this.ports = (init && init.ports) || [];
    }
  };

  win.document.head = {
    appendChild(child) {
      win.document._headChildren = win.document._headChildren || [];
      win.document._headChildren.push(child);
      return child;
    }
  };
  win.document.body = new win.HTMLElement();

  return win;
}

// Create mock window for coveryourtracks.eff.org
const winCYT = createMockWindow('coveryourtracks.eff.org', 'Linux x86_64');
const contextCYT = vm.createContext(winCYT);
vm.runInContext(stealthCode, contextCYT);

console.log('Testing native function disguise (makeNative)...');
const toDataURL = winCYT.HTMLCanvasElement.prototype.toDataURL;
assert.strictEqual(winCYT.Function.prototype.toString.call(toDataURL), 'function toDataURL() { [native code] }');
assert.strictEqual(toDataURL.name, 'toDataURL');
assert.strictEqual(Object.prototype.hasOwnProperty.call(toDataURL, 'prototype'), false);

const getParam = winCYT.WebGLRenderingContext.prototype.getParameter;
assert.strictEqual(winCYT.Function.prototype.toString.call(getParam), 'function getParameter() { [native code] }');
assert.strictEqual(getParam.name, 'getParameter');

// Disguise checks for new timezone and font hooks
assert.strictEqual(winCYT.Function.prototype.toString.call(winCYT.Date), 'function Date() { [native code] }');
assert.strictEqual(winCYT.Function.prototype.toString.call(winCYT.Date.prototype.getTimezoneOffset), 'function getTimezoneOffset() { [native code] }');
assert.strictEqual(winCYT.Function.prototype.toString.call(winCYT.Date.prototype.toString), 'function toString() { [native code] }');
assert.strictEqual(winCYT.Function.prototype.toString.call(winCYT.Date.prototype.toTimeString), 'function toTimeString() { [native code] }');
assert.strictEqual(winCYT.Function.prototype.toString.call(winCYT.Date.prototype.toLocaleString), 'function toLocaleString() { [native code] }');
assert.strictEqual(winCYT.Function.prototype.toString.call(winCYT.Date.prototype.getHours), 'function getHours() { [native code] }');
assert.strictEqual(winCYT.Function.prototype.toString.call(winCYT.Date.prototype.setHours), 'function setHours() { [native code] }');
assert.strictEqual(winCYT.Function.prototype.toString.call(winCYT.Date.prototype.setFullYear), 'function setFullYear() { [native code] }');
assert.strictEqual(winCYT.Function.prototype.toString.call(winCYT.Date.prototype.getYear), 'function getYear() { [native code] }');
assert.strictEqual(winCYT.Function.prototype.toString.call(winCYT.Date.prototype.setYear), 'function setYear() { [native code] }');
assert.strictEqual(winCYT.Function.prototype.toString.call(winCYT.Date.parse), 'function parse() { [native code] }');
assert.strictEqual(winCYT.Function.prototype.toString.call(winCYT.Intl.DateTimeFormat), 'function DateTimeFormat() { [native code] }');
assert.strictEqual(winCYT.Function.prototype.toString.call(winCYT.Intl.DateTimeFormat.prototype.resolvedOptions), 'function resolvedOptions() { [native code] }');
assert.strictEqual(winCYT.Function.prototype.toString.call(winCYT.CanvasRenderingContext2D.prototype.measureText), 'function measureText() { [native code] }');
assert.strictEqual(winCYT.Function.prototype.toString.call(winCYT.document.fonts.check), 'function check() { [native code] }');
assert.strictEqual(winCYT.Function.prototype.toString.call(winCYT.document.fonts.load), 'function load() { [native code] }');
assert.strictEqual(winCYT.Function.prototype.toString.call(winCYT.CSSStyleDeclaration.prototype.getPropertyValue), 'function getPropertyValue() { [native code] }');

assert.strictEqual(winCYT.Function.prototype.toString.call(winCYT.Function.prototype.toString), 'function toString() { [native code] }');
assert.throws(() => winCYT.Function.prototype.toString.call({}), /TypeError/, 'Calling toString on non-function must throw TypeError');
console.log('✓ Function disguise conforms to native signatures.\n');

console.log('Testing WebGL spoofing and platform detection...');
const gl = new winCYT.WebGLRenderingContext();
assert.strictEqual(gl.getParameter(37445), 'Google Inc. (NVIDIA)');
assert(gl.getParameter(37446).includes('OpenGL'), 'Default Linux platform spoof must use OpenGL renderer');
const ext = gl.getExtension('WEBGL_debug_renderer_info');
assert(ext && ext.UNMASKED_VENDOR_WEBGL === 37445);
assert(gl.getSupportedExtensions().includes('WEBGL_debug_renderer_info'), 'getSupportedExtensions must include WEBGL_debug_renderer_info');
console.log('✓ WebGL Vendor/Renderer correctly spoofed with platform awareness.\n');

console.log('Testing WebRTC SDP sanitization and IP suppression...');
const pc = new winCYT.RTCPeerConnection();
pc.createOffer().then(offer => {
  assert(!offer.sdp.includes('192.168.1.100'), 'Local IP 192.168.1.100 must be stripped from SDP');
  assert(!offer.sdp.includes('10.0.0.5'), 'Local IP 10.0.0.5 must be stripped from SDP');
  assert(offer.sdp.includes('203.0.113.1'), 'Public srflx candidate should be retained');
  console.log('✓ WebRTC SDP offer stripped of private IPv4 addresses.');
});
pc.createAnswer().then(answer => {
  assert(!answer.sdp.includes('192.168.1.100'), 'Local IP 192.168.1.100 must be stripped from answer SDP');
  assert(!answer.sdp.includes('10.0.0.5'), 'Local IP 10.0.0.5 must be stripped from answer SDP');
  assert(answer.sdp.includes('203.0.113.1'), 'Public srflx candidate should be retained in answer SDP');
});

// Test localDescription getter sanitization
const localDesc = pc.localDescription;
assert(localDesc && !localDesc.sdp.includes('192.168.1.100'), 'pc.localDescription.sdp must be sanitized');

// Test setLocalDescription hook
const rawOffer = new winCYT.RTCSessionDescription({
  type: 'offer',
  sdp: 'a=candidate:1 1 UDP 2122260223 192.168.1.100 54321 typ host\r\n'
});
pc.setLocalDescription(rawOffer);
assert(!pc.localDescription.sdp.includes('192.168.1.100'), 'setLocalDescription with raw offer must sanitize sdp');

// Test suppression of host candidate
let hostDispatched = false;
pc.onicecandidate = (e) => { hostDispatched = true; };
pc.dispatchEvent({
  type: 'icecandidate',
  candidate: { candidate: 'candidate:1 1 UDP 2122260223 192.168.1.100 54321 typ host generation 0' }
});
assert.strictEqual(hostDispatched, false, 'Private IP host candidate event must be suppressed');

// Test suppression of STUN srflx candidate leaking private IP via raddr
let srflxDispatched = false;
pc.onicecandidate = (e) => { srflxDispatched = true; };
pc.dispatchEvent({
  type: 'icecandidate',
  candidate: { candidate: 'candidate:3 1 UDP 1686052607 203.0.113.1 54321 typ srflx raddr 192.168.1.100 rport 54321' }
});
assert.strictEqual(srflxDispatched, false, 'STUN srflx candidate with private raddr must be suppressed');
console.log('✓ WebRTC candidate suppression prevents private IP and raddr leakage.\n');

console.log('Testing MediaDevices device enumeration anonymization & prototype...');
winCYT.navigator.mediaDevices.enumerateDevices().then(devices => {
  assert(Array.isArray(devices) && devices.length > 0, 'enumerateDevices must return devices array');
  for (const d of devices) {
    assert.strictEqual(d.deviceId, '', 'deviceId must be blank');
    assert.strictEqual(d.groupId, '', 'groupId must be blank');
    assert.strictEqual(d.label, '', 'label must be blank');
    assert(d.kind === 'audioinput' || d.kind === 'videoinput', 'kind must be preserved');
    assert(d instanceof winCYT.MediaDeviceInfo, 'Device must preserve MediaDeviceInfo prototype');
  }
  console.log('✓ Media devices enumerateDevices successfully anonymized and retains MediaDeviceInfo prototype.\n');
});

console.log('Testing DOMRect geometry integrity and Font metrics...');
const el = new winCYT.Element();
const rect = el.getBoundingClientRect();
assert(rect instanceof winCYT.DOMRect, 'getBoundingClientRect must return instanceof DOMRect');
assert.strictEqual(rect.x, rect.left, 'rect.x must equal rect.left');
assert.strictEqual(rect.y, rect.top, 'rect.y must equal rect.top');
assert.strictEqual(rect.width, rect.right - rect.left, 'rect.width must equal rect.right - rect.left');
assert.strictEqual(rect.height, rect.bottom - rect.top, 'rect.height must equal rect.bottom - rect.top');

const htmlEl = new winCYT.HTMLElement();
assert.strictEqual(typeof htmlEl.offsetWidth, 'number', 'offsetWidth must be a number');
assert.strictEqual(Number.isInteger(htmlEl.offsetWidth), true, 'offsetWidth must be an integer (WebIDL long)');
assert.strictEqual(Number.isInteger(htmlEl.offsetHeight), true, 'offsetHeight must be an integer (WebIDL long)');
console.log('✓ DOMRect geometric identities and integer font dimensions verified.\n');

console.log('Testing Navigator, Language, and Privacy Properties...');
assert.strictEqual(winCYT.navigator.webdriver, false, 'navigator.webdriver must be false');
assert.strictEqual(winCYT.navigator.doNotTrack, '1', 'navigator.doNotTrack must be "1"');
assert.strictEqual(winCYT.navigator.globalPrivacyControl, true, 'navigator.globalPrivacyControl must be true');
assert.strictEqual(winCYT.doNotTrack, undefined, 'window.doNotTrack must NOT exist (avoids obsolete IE9 pollution)');

// Browser Platform, UA, and Language Hooks
assert.strictEqual(winCYT.navigator.platform, 'Linux x86_64', 'navigator.platform must report Linux x86_64');
assert(winCYT.navigator.userAgent.includes('X11; Linux x86_64'), 'navigator.userAgent must report Linux x86_64');
assert(winCYT.navigator.appVersion.includes('X11; Linux x86_64'), 'navigator.appVersion must report Linux x86_64');
assert.strictEqual(winCYT.navigator.deviceMemory, 8, 'navigator.deviceMemory must be spoofed to 8');
assert.strictEqual(winCYT.navigator.language, 'en-US', 'navigator.language must be hooked to en-US');
assert.deepStrictEqual([...winCYT.navigator.languages], ['en-US', 'en'], 'navigator.languages must be hooked to ["en-US", "en"]');
console.log('✓ Browser platform (Linux x86_64) and language successfully spoofed.\n');

// window.chrome emulation
assert(winCYT.chrome, 'window.chrome must be present');
assert(winCYT.chrome.app && typeof winCYT.chrome.csi === 'function' && typeof winCYT.chrome.loadTimes === 'function', 'window.chrome standard builtins (app, csi, loadTimes) must be present');
console.log('✓ Navigator, privacy flags, and window.chrome emulation verified.\n');

console.log('Testing Intl Locale and English Formatting...');
const dtf = new winCYT.Intl.DateTimeFormat();
assert.strictEqual(dtf.resolvedOptions().locale, 'en-US', 'DateTimeFormat locale must resolve to en-US');

const nf = new winCYT.Intl.NumberFormat();
assert.strictEqual(nf.resolvedOptions().locale, 'en-US', 'NumberFormat locale must resolve to en-US');
assert.strictEqual(nf.format(1234567.89), '1,234,567.89', 'NumberFormat must use English comma grouping');

// Test empty array and Chinese locales handling
assert.strictEqual(new winCYT.Intl.NumberFormat([]).resolvedOptions().locale, 'en-US', 'Empty locales array must default to en-US');
assert.strictEqual(new winCYT.Intl.NumberFormat(['zh-CN']).resolvedOptions().locale, 'en-US', 'Chinese locale array must resolve to en-US');
assert.strictEqual(new winCYT.Intl.NumberFormat(['zh-CN', 'en-US']).resolvedOptions().locale, 'en-US', 'Mixed locale array with Chinese must resolve to en-US');

const pr = new winCYT.Intl.PluralRules();
assert.strictEqual(pr.resolvedOptions().locale, 'en-US', 'PluralRules locale must resolve to en-US');

const rtf = new winCYT.Intl.RelativeTimeFormat();
assert.strictEqual(rtf.resolvedOptions().locale, 'en-US', 'RelativeTimeFormat locale must resolve to en-US');

const col = new winCYT.Intl.Collator();
assert.strictEqual(col.resolvedOptions().locale, 'en-US', 'Collator locale must resolve to en-US');
console.log('✓ All Intl constructors and resolvedOptions cleanly localized to en-US.\n');

console.log('Testing Timezone Dynamic Auto-sync and Date Hooks...');
// Initial timezone matches America/Los_Angeles
assert.strictEqual(dtf.resolvedOptions().timeZone, 'America/Los_Angeles', 'Default detected timezone must be America/Los_Angeles');

const testDateSummer = new winCYT.Date('2026-09-29T12:00:00Z');
// In Los Angeles (PDT): offset is 420 minutes (UTC-7)
assert.strictEqual(testDateSummer.getTimezoneOffset(), 420, 'getTimezoneOffset in Summer (PDT) must be 420');
assert(testDateSummer.toString().includes('GMT-0700'), 'Date.toString must include GMT-0700');
assert(testDateSummer.toString().includes('Pacific Daylight Time'), 'Date.toString must include Pacific Daylight Time');
assert(testDateSummer.toTimeString().includes('GMT-0700 (Pacific Daylight Time)'), 'toTimeString must include GMT-0700 (Pacific Daylight Time)');
assert.strictEqual(testDateSummer.toDateString(), 'Tue Sep 29 2026', 'toDateString must match Tue Sep 29 2026');
assert.strictEqual(testDateSummer.getHours(), 5, 'getHours in LA for 12:00 UTC must be 5 (12 - 7)');
assert(testDateSummer.toLocaleString().includes('9/29/2026'), 'toLocaleString must format date in English');
assert(testDateSummer.toLocaleString().includes('5:00:00 AM'), 'toLocaleString must format time in Pacific Time');

// Test Date local getters consistency in activeTimezone
assert.strictEqual(testDateSummer.getHours(), 5, 'getHours in LA for 12:00 UTC must be 5');
assert.strictEqual(testDateSummer.getMinutes(), 0, 'getMinutes must be 0');
assert.strictEqual(testDateSummer.getSeconds(), 0, 'getSeconds must be 0');
assert.strictEqual(testDateSummer.getDate(), 29, 'getDate must be 29');
assert.strictEqual(testDateSummer.getMonth(), 8, 'getMonth must be 8 (September)');
assert.strictEqual(testDateSummer.getFullYear(), 2026, 'getFullYear must be 2026');
assert.strictEqual(testDateSummer.getYear(), 126, 'getYear must be 126');

// Test Date() without new returns string and matches new Date().toString()
assert.strictEqual(typeof winCYT.Date(), 'string', 'Date() without new must return string');
assert.strictEqual(winCYT.Date(), (new winCYT.Date()).toString(), 'Date() without new must match (new Date()).toString()');

// Test Date local setter in active timezone
const modDate = new winCYT.Date('2026-09-29T12:00:00Z');
modDate.setHours(15);
assert.strictEqual(modDate.getHours(), 15, 'setHours(15) must result in getHours() === 15 in active timezone');

// Test zero window backdoor leakage
assert.strictEqual('__BOCCHI_TIMEZONE__' in winCYT, false, '__BOCCHI_TIMEZONE__ must NOT be defined on window');
assert.strictEqual('__BOCCHI_SESSION_SALT__' in winCYT, false, '__BOCCHI_SESSION_SALT__ must NOT be defined on window');
assert.strictEqual('__bocchiSetTimezone' in winCYT, false, '__bocchiSetTimezone must NOT be defined on window');

function setTestTimezone(win, tz) {
  win.document.dispatchEvent({
    type: '__bocchi_tz_sync__',
    detail: { timezone: tz },
    stopImmediatePropagation() {}
  });
}

// Test dynamic Intl.DateTimeFormat timezone tracking for default instances
const dtfDyn = new winCYT.Intl.DateTimeFormat();
assert.strictEqual(dtfDyn.resolvedOptions().timeZone, 'America/Los_Angeles');
setTestTimezone(winCYT, 'Europe/London');
assert.strictEqual(dtfDyn.resolvedOptions().timeZone, 'Europe/London', 'Default dtf instance must dynamically track timezone update');
setTestTimezone(winCYT, 'America/Los_Angeles');

const testDateWinter = new winCYT.Date('2026-01-15T12:00:00Z');
// In Los Angeles (PST): offset is 480 minutes (UTC-8)
assert.strictEqual(testDateWinter.getTimezoneOffset(), 480, 'getTimezoneOffset in Winter (PST) must be 480');
assert(testDateWinter.toString().includes('GMT-0800'), 'Date.toString must include GMT-0800');
assert(testDateWinter.toString().includes('Pacific Standard Time'), 'Date.toString must include Pacific Standard Time');
assert.strictEqual(testDateWinter.getHours(), 4, 'getHours in LA for 12:00 UTC in Winter must be 4 (12 - 8)');
assert.strictEqual(testDateWinter.getMinutes(), 0, 'getMinutes must be 0');
assert.strictEqual(testDateWinter.getSeconds(), 0, 'getSeconds must be 0');
assert.strictEqual(testDateWinter.getDate(), 15, 'getDate must be 15');
assert.strictEqual(testDateWinter.getDay(), 4, 'getDay must be 4');
assert.strictEqual(testDateWinter.getMonth(), 0, 'getMonth must be 0');
assert.strictEqual(testDateWinter.getFullYear(), 2026, 'getFullYear must be 2026');
assert.strictEqual(testDateWinter.getYear(), 126, 'getYear must be 126');

// Test Dynamic Timezone Switching to America/New_York
setTestTimezone(winCYT, 'America/New_York');
assert.strictEqual(new winCYT.Intl.DateTimeFormat().resolvedOptions().timeZone, 'America/New_York', 'DateTimeFormat must reflect updated timezone');
assert.strictEqual(new winCYT.Date('2026-09-29T12:00:00Z').getTimezoneOffset(), 240, 'Summer offset in NY (EDT) must be 240 (UTC-4)');
assert(new winCYT.Date('2026-09-29T12:00:00Z').toString().includes('GMT-0400 (Eastern Daylight Time)'), 'Date.toString must reflect NY EDT');
assert.strictEqual(new winCYT.Date('2026-09-29T12:00:00Z').getHours(), 8, 'getHours in NY for 12:00 UTC must be 8 (12 - 4)');

// Test Dynamic Timezone Switching to Asia/Tokyo (UTC+9)
setTestTimezone(winCYT, 'Asia/Tokyo');
assert.strictEqual(new winCYT.Date('2026-09-29T12:00:00Z').getTimezoneOffset(), -540, 'Offset in Tokyo must be -540 (UTC+9)');
assert(new winCYT.Date('2026-09-29T12:00:00Z').toString().includes('GMT+0900 (Japan Standard Time)'), 'Date.toString must reflect Tokyo JST');
assert.strictEqual(new winCYT.Date('2026-09-29T12:00:00Z').getHours(), 21, 'getHours in Tokyo for 12:00 UTC must be 21 (12 + 9)');

// Test CustomEvent __bocchi_tz_sync__ and ensure window.postMessage is ignored
winCYT.document.dispatchEvent({
  type: '__bocchi_tz_sync__',
  detail: { timezone: 'Europe/Paris' },
  stopImmediatePropagation() {}
});
assert.strictEqual(new winCYT.Intl.DateTimeFormat().resolvedOptions().timeZone, 'Europe/Paris', 'CustomEvent __bocchi_tz_sync__ must sync timezone');
winCYT.postMessage({ type: '__BOCCHI_TIMEZONE_UPDATE__', timezone: 'Asia/Shanghai' }, '*');
assert.strictEqual(new winCYT.Intl.DateTimeFormat().resolvedOptions().timeZone, 'Europe/Paris', 'postMessage must not sync timezone');

// Reset back to America/Los_Angeles
setTestTimezone(winCYT, 'America/Los_Angeles');

// Non-constructor invocation (without new)
const dtfNoNew = winCYT.Intl.DateTimeFormat();
assert.strictEqual(dtfNoNew.resolvedOptions().locale, 'en-US', 'DateTimeFormat without new must resolve to en-US');
assert.strictEqual(dtfNoNew.resolvedOptions().timeZone, 'America/Los_Angeles', 'DateTimeFormat without new must resolve to America/Los_Angeles');

// UTC and ISO string methods preservation
const testDateUTC = new winCYT.Date('2026-09-29T12:00:00.000Z');
assert.strictEqual(testDateUTC.toISOString(), '2026-09-29T12:00:00.000Z', 'toISOString must preserve pure UTC time');
assert.strictEqual(testDateUTC.getUTCHours(), 12, 'getUTCHours must return 12 in UTC');

// Custom explicit timeZone in toLocaleString must be respected
assert(testDateUTC.toLocaleString('en-GB', { timeZone: 'UTC' }).includes('12:00:00'), 'Explicit timeZone in toLocaleString must be respected');

// Chinese locale in toLocaleString must be sanitized to English
assert(!testDateUTC.toLocaleString('zh-CN').includes('上午') && !testDateUTC.toLocaleString('zh-CN').includes('下午'), 'Chinese locale in toLocaleString must default to English format');

// Invalid Date handling and TypeError on invalid receiver
const invDate = new winCYT.Date('invalid');
assert.strictEqual(invDate.toString(), 'Invalid Date', 'Invalid Date toString must return "Invalid Date"');
assert.strictEqual(invDate.toTimeString(), 'Invalid Date', 'Invalid Date toTimeString must return "Invalid Date"');
assert.strictEqual(invDate.toDateString(), 'Invalid Date', 'Invalid Date toDateString must return "Invalid Date"');
assert.strictEqual(invDate.toLocaleString(), 'Invalid Date', 'Invalid Date toLocaleString must return "Invalid Date"');
assert(isNaN(invDate.getTimezoneOffset()), 'Invalid Date getTimezoneOffset must be NaN');
assert(isNaN(invDate.getHours()), 'Invalid Date getHours must be NaN');
assert(isNaN(invDate.getMinutes()), 'Invalid Date getMinutes must be NaN');
assert(isNaN(invDate.getSeconds()), 'Invalid Date getSeconds must be NaN');
assert(isNaN(invDate.getDate()), 'Invalid Date getDate must be NaN');
assert(isNaN(invDate.getDay()), 'Invalid Date getDay must be NaN');
assert(isNaN(invDate.getMonth()), 'Invalid Date getMonth must be NaN');
assert(isNaN(invDate.getFullYear()), 'Invalid Date getFullYear must be NaN');
assert(isNaN(invDate.getYear()), 'Invalid Date getYear must be NaN');
assert.throws(() => winCYT.Date.prototype.toString.call({}), /TypeError/, 'Date.toString on non-Date receiver must throw TypeError');
assert.throws(() => winCYT.Date.prototype.getTimezoneOffset.call({}), /TypeError/, 'Date.getTimezoneOffset on non-Date receiver must throw TypeError');
['getHours', 'getMinutes', 'getSeconds', 'getDate', 'getDay', 'getMonth', 'getFullYear', 'getYear'].forEach(fn => {
  assert.throws(() => winCYT.Date.prototype[fn].call({}), /TypeError/, `Date.${fn} on non-Date receiver must throw TypeError`);
});
console.log('✓ Dynamic Timezone Auto-sync, Date hooks, and error handling verified.\n');

console.log('Testing Font Fingerprint Masking (Hide Chinese Fonts)...');
// 1. Canvas measureText masking
const canvasFont = new winCYT.HTMLCanvasElement();
const ctxFont = canvasFont.getContext('2d');

ctxFont.font = '72px "SimSun", monospace';
const widthSimSun = ctxFont.measureText('mmmmmm').width;

ctxFont.font = '72px monospace';
const widthFallback = ctxFont.measureText('mmmmmm').width;
assert.strictEqual(widthSimSun, widthFallback, 'SimSun probe must match monospace fallback metric exactly');

ctxFont.font = '72px "Microsoft YaHei", sans-serif';
const widthYaHei = ctxFont.measureText('mmmmmm').width;
ctxFont.font = '72px sans-serif';
const widthSans = ctxFont.measureText('mmmmmm').width;
assert.strictEqual(widthYaHei, widthSans, 'Microsoft YaHei probe must match sans-serif fallback metric exactly');

// 2. DOM probe offsetWidth and offsetHeight masking (inline styles)
const probeEl = new winCYT.HTMLElement();
probeEl.style.fontFamily = '"SimSun", monospace';
assert.strictEqual(probeEl.offsetWidth, 150, 'SimSun probe offsetWidth must mask to fallback 150');
assert.strictEqual(probeEl.offsetHeight, 76, 'SimSun probe offsetHeight must mask to fallback 76');

// 2.1 Solitary Chinese font probe (BrowserLeaks style: single font name without generic fallback)
const singleProbeEl = new winCYT.HTMLElement();
singleProbeEl.style.fontFamily = 'SimSun';
assert.strictEqual(singleProbeEl.offsetWidth, 150, 'Solitary SimSun probe offsetWidth must mask to fallback 150 without leaking sans-serif');
assert.strictEqual(singleProbeEl.offsetHeight, 76, 'Solitary SimSun probe offsetHeight must mask to fallback 76');

// 3. DOM probe getBoundingClientRect masking (inline styles)
const probeRect = probeEl.getBoundingClientRect();
assert.strictEqual(probeRect.width, 100, 'SimSun probe getBoundingClientRect width must mask to fallback 100');

// 4. DOM probe masking when styled via CSS stylesheet/class (_computedFontFamily)
const classEl = new winCYT.HTMLElement();
classEl._computedFontFamily = '"SimSun", monospace';
assert.strictEqual(classEl.offsetWidth, 150, 'Class-styled SimSun probe offsetWidth must mask to fallback 150');
assert.strictEqual(classEl.offsetHeight, 76, 'Class-styled SimSun probe offsetHeight must mask to fallback 76');
assert.strictEqual(classEl.getBoundingClientRect().width, 100, 'Class-styled SimSun probe getBoundingClientRect width must mask to fallback 100');

// 5. CSSStyleDeclaration font masking
const computedStyle = winCYT.getComputedStyle(classEl);
assert.strictEqual(computedStyle.fontFamily, 'monospace', 'getComputedStyle.fontFamily must mask SimSun');
assert.strictEqual(computedStyle.getPropertyValue('font-family'), 'monospace', 'getComputedStyle.getPropertyValue must mask SimSun');

// 6. Standard English font metrics integrity
probeEl.style.fontFamily = 'Arial, sans-serif';
assert.strictEqual(probeEl.offsetWidth, 150, 'Standard English font returns true element dimensions 150');

// 7. document.fonts.check masking
assert.strictEqual(winCYT.document.fonts.check('12px "SimSun"'), false, 'Chinese font SimSun check must return false');
assert.strictEqual(winCYT.document.fonts.check('16px "Microsoft YaHei"'), false, 'Chinese font Microsoft YaHei check must return false');
assert.strictEqual(winCYT.document.fonts.check('14px "WenQuanYi Micro Hei"'), false, 'Chinese font WenQuanYi check must return false');
assert.strictEqual(winCYT.document.fonts.check('14px "PingFang SC"'), false, 'Chinese font PingFang check must return false');
assert.strictEqual(winCYT.document.fonts.check('16px Arial'), true, 'Standard English font Arial check must return true');
assert.strictEqual(winCYT.document.fonts.check('14px "Times New Roman"'), true, 'Standard English font Times New Roman check must return true');
// 7.1 speechSynthesis.getVoices Linux normalization
const voices = winCYT.speechSynthesis.getVoices();
assert(Array.isArray(voices) && voices.length >= 3, 'speechSynthesis.getVoices must return standard voices array');
assert(voices.some(v => v.name && v.name.includes('Google US English')), 'speechSynthesis must include Google US English');
assert(!voices.some(v => v.name && v.name.includes('Microsoft')), 'Must not leak Microsoft voices on Linux');
assert(winCYT.speechSynthesis.getVoices.toString().includes('[native code]'), 'speechSynthesis.getVoices must appear native');

// 8. document.fonts.load masking
winCYT.document.fonts.load('16px "SimSun"').then(fonts => {
  assert.strictEqual(fonts.length, 0, 'fonts.load for SimSun must return empty array');
});
winCYT.document.fonts.load('16px Arial').then(fonts => {
  assert.strictEqual(fonts.length, 1, 'fonts.load for Arial must return font face');
});

// 9. queryLocalFonts masking
winCYT.queryLocalFonts().then(fonts => {
  assert(Array.isArray(fonts) && fonts.length > 0, 'queryLocalFonts must return array');
  for (const f of fonts) {
    assert(!f.family.includes('SimSun'), 'queryLocalFonts must not contain SimSun');
    assert(!f.family.includes('Microsoft YaHei'), 'queryLocalFonts must not contain Microsoft YaHei');
  }
  const families = fonts.map(f => f.family);
  assert(families.includes('Arial'), 'queryLocalFonts must retain Arial');
  assert(families.includes('Times New Roman'), 'queryLocalFonts must retain Times New Roman');
  console.log('✓ queryLocalFonts correctly masks Chinese fonts while retaining English fonts.');
});

// 10. DOM Range font masking (TraceScope domRange detection)
const rangeSpan = new winCYT.HTMLElement();
rangeSpan.style.fontFamily = '"SimSun", monospace';
const range = winCYT.document.createRange();
range.selectNode(rangeSpan);
const rangeRect = range.getBoundingClientRect();
assert.strictEqual(rangeRect.width, 100, 'Range.getBoundingClientRect must mask SimSun to monospace fallback width 100');
const rangeRects = range.getClientRects();
assert.strictEqual(rangeRects[0].width, 100, 'Range.getClientRects must mask SimSun to monospace fallback width 100');
assert.strictEqual(rangeSpan.style.fontFamily, '"SimSun", monospace', 'Inline style restored after range measurement');

// 11. SVG font masking (TraceScope svg detection)
const svgText = new winCYT.SVGTextContentElement();
svgText.setAttribute('font-family', '"SimHei", sans-serif');
assert.strictEqual(svgText.getComputedTextLength(), 100, 'SVGTextContentElement.getComputedTextLength must mask SimHei to 100');
assert.strictEqual(svgText.getAttribute('font-family'), '"SimHei", sans-serif', 'SVG font-family attribute restored after measurement');
const svgG = new winCYT.SVGGraphicsElement();
svgG.setAttribute('font-family', '"SimSun", monospace');
assert.strictEqual(svgG.getBBox().width, 100, 'SVGGraphicsElement.getBBox must mask SimSun to 100');
assert.strictEqual(svgG.getAttribute('font-family'), '"SimSun", monospace', 'SVG font-family attribute restored after getBBox');

// 11.1 Custom hidden font management and dynamic synchronization
winCYT.document.dispatchEvent({
  type: '__bocchi_fonts_sync__',
  detail: {
    customFonts: ['CustomBrandFont', '/secret-font-\\d+/'],
    allowedFonts: ['SimSun'], // Explicitly whitelist SimSun
    blockBuiltin: true
  },
  stopImmediatePropagation() {}
});

assert.strictEqual(winCYT.document.fonts.check('16px "CustomBrandFont"'), false, 'Custom brand font check must return false');
assert.strictEqual(winCYT.document.fonts.check('16px "secret-font-99"'), false, 'Regex-matched custom font check must return false');
assert.strictEqual(winCYT.document.fonts.check('16px Arial'), true, 'Standard Arial font check must still return true');
assert.strictEqual(winCYT.document.fonts.check('16px "SimSun"'), true, 'Explicitly whitelisted SimSun check must return true');

const customProbeEl = new winCYT.HTMLElement();
customProbeEl.style.fontFamily = 'CustomBrandFont';
assert.strictEqual(customProbeEl.offsetWidth, 150, 'Custom font offsetWidth must mask to fallback');

// Reset SimSun back to masked
winCYT.document.dispatchEvent({
  type: '__bocchi_fonts_sync__',
  detail: { customFonts: [], allowedFonts: [], blockBuiltin: true },
  stopImmediatePropagation() {}
});
assert.strictEqual(winCYT.document.fonts.check('12px "SimSun"'), false, 'SimSun must be masked after reset');

// 11.2 Whitelist Mode validation
winCYT.document.dispatchEvent({
  type: '__bocchi_fonts_sync__',
  detail: {
    fontMode: 'whitelist',
    allowedFonts: ['Arial', 'Liberation Sans'],
    customFonts: [],
    blockBuiltin: true
  },
  stopImmediatePropagation() {}
});
assert.strictEqual(winCYT.document.fonts.check('16px Arial'), true, 'Whitelisted Arial must return true');
assert.strictEqual(winCYT.document.fonts.check('16px "Liberation Sans"'), true, 'Whitelisted Liberation Sans must return true');
assert.strictEqual(winCYT.document.fonts.check('16px "Times New Roman"'), false, 'Non-whitelisted Times New Roman must be masked in whitelist mode');
assert.strictEqual(winCYT.document.fonts.check('16px "SimSun"'), false, 'Non-whitelisted SimSun must be masked in whitelist mode');

// Restore to Blacklist mode
winCYT.document.dispatchEvent({
  type: '__bocchi_fonts_sync__',
  detail: {
    fontMode: 'blacklist',
    allowedFonts: [],
    customFonts: [],
    blockBuiltin: true
  },
  stopImmediatePropagation() {}
});
assert.strictEqual(winCYT.document.fonts.check('16px "Times New Roman"'), true, 'Times New Roman must be allowed in blacklist mode');
assert.strictEqual(winCYT.document.fonts.check('16px "SimSun"'), false, 'SimSun must be masked in blacklist mode');

// 12. Web Worker & SharedWorker cross-context protection
const worker = new winCYT.Worker('worker.js');
assert.strictEqual(winCYT.Worker.name, 'Worker', 'Worker constructor name must be Worker');
assert.strictEqual(winCYT.Worker.toString(), 'function Worker() { [native code] }', 'Worker toString must look native');
assert.strictEqual(worker instanceof winCYT.Worker, true, 'Worker instance must pass instanceof check');
assert.throws(() => winCYT.Worker('worker.js'), /Failed to construct 'Worker'/, 'Calling Worker without new must throw TypeError');
assert.throws(() => new winCYT.Worker(), /1 argument required/, 'Calling Worker with 0 args must throw TypeError');

const workerBlob = winCYT.URL._created.get(worker.scriptURL);
assert(workerBlob, 'Worker script must be wrapped in a blob URL');
assert(workerBlob.content.includes('Linux x86_64'), 'Worker bootstrap must spoof Linux x86_64');
assert(workerBlob.content.includes("['en-US', 'en']"), 'Worker bootstrap must spoof en-US languages');
assert(workerBlob.content.includes('DateTimeFormat'), 'Worker bootstrap must spoof Intl.DateTimeFormat');
assert(workerBlob.content.includes('getTimezoneOffset'), 'Worker bootstrap must spoof Date timezone offset');

const sharedWorker = new winCYT.SharedWorker('shared_worker.js');
assert.strictEqual(winCYT.SharedWorker.name, 'SharedWorker', 'SharedWorker constructor name must be SharedWorker');
assert.strictEqual(winCYT.SharedWorker.toString(), 'function SharedWorker() { [native code] }', 'SharedWorker toString must look native');
assert.strictEqual(sharedWorker instanceof winCYT.SharedWorker, true, 'SharedWorker instance must pass instanceof check');
assert.throws(() => winCYT.SharedWorker('shared_worker.js'), /Failed to construct 'SharedWorker'/, 'Calling SharedWorker without new must throw TypeError');
assert.throws(() => new winCYT.SharedWorker(), /1 argument required/, 'Calling SharedWorker with 0 args must throw TypeError');

console.log('✓ Font fingerprinting probes (Canvas, DOM, Range, SVG, fonts.check/load) cleanly masked.');
console.log('✓ Web Worker and SharedWorker cross-context protections verified.\n');

console.log('Testing Multi-Realm Iframe Protection...');
const iframe = new winCYT.HTMLIFrameElement();
const childWin = iframe.contentWindow;
assert.strictEqual(childWin.navigator.webdriver, false, 'Child iframe navigator.webdriver must be false');
assert.strictEqual(childWin.navigator.language, 'en-US', 'Child iframe navigator.language must be en-US');
assert.strictEqual(new childWin.Intl.DateTimeFormat().resolvedOptions().timeZone, 'America/Los_Angeles', 'Child iframe must inherit IP timezone');
assert.strictEqual(childWin.document.fonts.check('12px "SimSun"'), false, 'Child iframe must mask Chinese fonts');
assert(new childWin.WebGLRenderingContext().getParameter(37445), 'Child iframe WebGL must be protected');
console.log('✓ Multi-realm iframe dynamically intercepted and protected.\n');

// 5. Test EFF Cover Your Tracks Multi-Domain Randomization vs Intra-Domain Consistency
console.log('[Test 5] Validating EFF Cover Your Tracks Multi-Domain Randomization & Consistency...');
const winFPS = createMockWindow('firstpartysimulator.net', 'Linux x86_64');
const contextFPS = vm.createContext(winFPS);
vm.runInContext(stealthCode, contextFPS);

// Metric 1: Canvas toDataURL
const canvasCYT1 = new winCYT.HTMLCanvasElement();
const ctxCYT1 = canvasCYT1.getContext('2d');
const urlCYT1 = canvasCYT1.toDataURL();

const canvasCYT2 = new winCYT.HTMLCanvasElement();
const ctxCYT2 = canvasCYT2.getContext('2d');
const urlCYT2 = canvasCYT2.toDataURL();

const canvasFPS = new winFPS.HTMLCanvasElement();
const ctxFPS = canvasFPS.getContext('2d');
const urlFPS = canvasFPS.toDataURL();

assert.strictEqual(urlCYT1, urlCYT2, 'Canvas data URL must be strictly identical within same domain session');
assert.notStrictEqual(urlCYT1, urlFPS, 'Canvas data URL must diverge across different domains');

// Scheme A: Clean native rendering on normal sites (browserleaks.com) to blend in with crowd
const winBL = createMockWindow('browserleaks.com', 'Linux x86_64');
vm.runInContext(stealthCode, vm.createContext(winBL));
const canvasBL = new winBL.HTMLCanvasElement();
const ctxBL = canvasBL.getContext('2d');
const urlBL = canvasBL.toDataURL();
assert.strictEqual(urlBL, 'data:image/png;base64,mockPngR100A255', 'Canvas on browserleaks.com must return clean native rendering without perturbation');

const glBL = new winBL.WebGLRenderingContext();
const pixelsBL = new Uint8Array(4);
glBL.readPixels(0, 0, 1, 1, 0, 0, pixelsBL);
assert.strictEqual(pixelsBL[0], 50, 'WebGL readPixels on browserleaks.com must return clean unperturbed pixel (50)');

const audioBL = new winBL.AudioBuffer();
const chBL = audioBL.getChannelData(0);
assert.strictEqual(chBL[100], Math.fround(Math.sin(100 / 100)), 'Audio samples on browserleaks.com must return clean unperturbed audio');

const pluginBL = new winBL.Plugin();
assert.strictEqual(pluginBL.description, 'Portable Document Format', 'Plugin description on browserleaks.com must be clean without appended spaces');
console.log('✓ Scheme A: Native hardware rendering on browserleaks.com (Canvas/WebGL/Audio/Plugins) blends into real hardware crowd.');

// Metric 2: WebGL readPixels
const glCYT = new winCYT.WebGLRenderingContext();
const pixelsCYT1 = new Uint8Array(4);
glCYT.readPixels(0, 0, 1, 1, 0, 0, pixelsCYT1);

const pixelsCYT2 = new Uint8Array(4);
glCYT.readPixels(0, 0, 1, 1, 0, 0, pixelsCYT2);

const glFPS = new winFPS.WebGLRenderingContext();
const pixelsFPS = new Uint8Array(4);
glFPS.readPixels(0, 0, 1, 1, 0, 0, pixelsFPS);

assert.deepStrictEqual(pixelsCYT1, pixelsCYT2, 'WebGL pixels must be strictly identical within same domain');
assert.notDeepStrictEqual(pixelsCYT1, pixelsFPS, 'WebGL pixels must diverge across different domains');
console.log('✓ WebGL readPixels: Stable within domain, randomized across domains.');

// Metric 3: AudioBuffer
const audioCYT1 = new winCYT.AudioBuffer();
const audioCYT2 = new winCYT.AudioBuffer();
const audioFPS = new winFPS.AudioBuffer();

const chCYT1 = audioCYT1.getChannelData(0);
const chCYT2 = audioCYT2.getChannelData(0);
const chFPS = audioFPS.getChannelData(0);

assert.strictEqual(chCYT1[100], chCYT2[100], 'Audio samples must be strictly identical within same domain');
assert.notStrictEqual(chCYT1[100], chFPS[100], 'Audio samples must diverge across different domains');
console.log('✓ Audio: Stable within domain, randomized across domains.');

// Metric 4: Hardware Concurrency
const concCYT = winCYT.navigator.hardwareConcurrency;
const concFPS = winFPS.navigator.hardwareConcurrency;
assert.notStrictEqual(concCYT, concFPS, 'Hardware concurrency must diverge across domains');
console.log(`✓ Hardware Concurrency: CYT=${concCYT} vs FPS=${concFPS} (Diverged).`);

// Metric 5: Plugins Description
const pluginCYT = new winCYT.Plugin();
const pluginFPS = new winFPS.Plugin();
assert.notStrictEqual(pluginCYT.description, pluginFPS.description, 'Plugin description must diverge across domains');
console.log(`✓ Plugins: CYT="${pluginCYT.description}" vs FPS="${pluginFPS.description}" (Diverged).\n`);

// 6. Test Edge Cases & Advanced Evasions
console.log('[Test 6] Validating Edge Cases & Advanced Evasions...');

// Legacy createOffer callback
const winLegacy = createMockWindow('legacy-test.com');
vm.runInContext(stealthCode, vm.createContext(winLegacy));
const pcLegacy = new winLegacy.RTCPeerConnection();
let legacyOfferReceived = null;
pcLegacy.createOffer((offer) => {
  legacyOfferReceived = offer;
}).then(() => {
  assert(legacyOfferReceived && !legacyOfferReceived.sdp.includes('192.168.1.100'), 'Legacy createOffer callback must receive sanitized SDP');
  console.log('✓ Legacy createOffer callback receives sanitized SDP.');
});

// Legacy createAnswer callback
let legacyAnswerReceived = null;
pcLegacy.createAnswer((answer) => {
  legacyAnswerReceived = answer;
}).then(() => {
  assert(legacyAnswerReceived && !legacyAnswerReceived.sdp.includes('192.168.1.100'), 'Legacy createAnswer callback must receive sanitized SDP');
  console.log('✓ Legacy createAnswer callback receives sanitized SDP.');
});

// Non-promise createOffer invocation robustness
const winNonPromise = createMockWindow('nonpromise-test.com');
winNonPromise.RTCPeerConnection.prototype.createOffer = function() {
  return undefined;
};
vm.runInContext(stealthCode, vm.createContext(winNonPromise));
const pcNonPromise = new winNonPromise.RTCPeerConnection();
assert.strictEqual(pcNonPromise.createOffer(), undefined, 'createOffer must safely handle non-promise / undefined returns');

// WebGL renderer spoofing
const winMac = createMockWindow('mac-test.com', 'Linux x86_64');
vm.runInContext(stealthCode, vm.createContext(winMac));
const glMac = new winMac.WebGLRenderingContext();
assert(glMac.getParameter(37446).includes('OpenGL'), 'Linux platform must spoof OpenGL renderer');
console.log('✓ WebGL correctly provides standard Linux OpenGL renderer strings.');

// Transparent Canvas toDataURL and toBlob non-clamping farbling
const canvasZero = new winCYT.HTMLCanvasElement();
const ctxZero = canvasZero.getContext('2d');
for (let i = 0; i < ctxZero._pixels.length; i++) ctxZero._pixels[i] = 0; // Pure transparent black
const dataUrlZero = canvasZero.toDataURL();
assert(!dataUrlZero.includes('mockPngR0A0'), 'Canvas toDataURL must mutate even on pure transparent pixels');
assert.strictEqual(ctxZero._pixels[0], 0, 'Canvas pixel data must be restored after toDataURL');
assert.strictEqual(ctxZero._pixels[3], 0, 'Canvas alpha channel must be restored after toDataURL');

canvasZero.toBlob((blob) => {
  assert(blob.r !== 0 || blob.a !== 0, 'Canvas toBlob must mutate transparent pixels');
});
console.log('✓ Canvas toDataURL and toBlob safely farbles and restores pure transparent pixels.');

// Element getClientRects integrity
const elRects = new winCYT.Element();
const clientRects = elRects.getClientRects();
assert(Array.isArray(clientRects) && clientRects.length > 0, 'getClientRects must return array of rects');
console.log('✓ getClientRects returns consistent rect collection.\n');

// 7. Test APIVoid & BotDetector Anti-Fingerprinting Defenses
console.log('[Test 7] Validating BotDetector & APIVoid Anti-Fingerprinting Defenses...');
const winBot = createMockWindow('apivoid.com', 'Linux x86_64');
vm.runInContext(stealthCode, vm.createContext(winBot));

// 7.1 WebGPU Adapter Spoofing
winBot.navigator.gpu.requestAdapter().then(adapter => {
  assert(adapter && adapter.info, 'WebGPU adapter must have info');
  assert.strictEqual(adapter.info.vendor, 'nvidia', 'WebGPU vendor must be spoofed to nvidia');
  assert.strictEqual(adapter.info.architecture, 'vulkan', 'WebGPU architecture must be vulkan for Linux');
  assert.strictEqual(adapter.info.description, 'NVIDIA GeForce RTX 3060', 'WebGPU description must match Linux RTX 3060 GPU');

  adapter.requestAdapterInfo().then(async info => {
    assert.strictEqual(info.architecture, 'vulkan', 'WebGPU requestAdapterInfo must return vulkan');
    console.log('✓ WebGPU adapter correctly spoofed with Linux Vulkan architecture.');

    // 7.2 WebGL Standard Parameters
    const gl = new winBot.WebGLRenderingContext();
    assert.strictEqual(gl.getParameter(0x1F00), 'WebKit', 'gl.VENDOR must be WebKit');
    assert.strictEqual(gl.getParameter(0x1F01), 'WebKit WebGL', 'gl.RENDERER must be WebKit WebGL');
    assert.strictEqual(gl.getParameter(0x8B8C), 'WebGL GLSL ES 1.0 (OpenGL ES GLSL ES 1.0 Chromium)', 'gl.SHADING_LANGUAGE_VERSION must be standard Chrome');
    console.log('✓ WebGL standard parameters (VENDOR, RENDERER, SHADING_LANGUAGE_VERSION) verified.');

    // 7.3 Screen availHeight Normalization
    assert.strictEqual(winBot.screen.availHeight, 1080, 'availHeight must report full height on Linux');
    console.log('✓ Screen availHeight verified on Linux.');

    // 7.5 Worker & SharedWorker Message Event Sanitization
    const worker = new winBot.Worker('dummy.js');
    let onmessageReceived = null;
    worker.onmessage = (ev) => {
      onmessageReceived = ev.data;
    };
    worker._listeners['message'][0]({
      data: {
        userAgent: 'Linux Mozilla/5.0 ...',
        platform: 'Linux x86_64',
        hardwareConcurrency: 16,
        language: 'zh-CN',
        languages: ['zh-CN', 'zh'],
        uaDataPlatform: 'Linux',
        highEntropy: { architecture: 'arm', bitness: '32', platformVersion: '6.5.0' },
        webglVendor: 'Mesa',
        webglRenderer: 'Mesa DRI Intel(R) UHD Graphics',
        fontsBits: '000000000000000'
      }
    });
    assert(onmessageReceived, 'Worker onmessage must be called');
    assert(onmessageReceived.userAgent.includes('Linux x86_64'), 'Worker userAgent must be sanitized to Linux');
    assert.strictEqual(onmessageReceived.platform, 'Linux x86_64', 'Worker platform must be sanitized to Linux x86_64');
    assert.strictEqual(onmessageReceived.hardwareConcurrency, 8, 'Worker hardwareConcurrency must be sanitized to 8');
    assert.strictEqual(onmessageReceived.language, 'en-US', 'Worker language must be sanitized to en-US');
    assert.strictEqual(JSON.stringify(onmessageReceived.languages), JSON.stringify(['en-US', 'en']), 'Worker languages must be sanitized to en-US, en');
    assert.strictEqual(onmessageReceived.uaDataPlatform, 'Linux', 'Worker uaDataPlatform must be sanitized to Linux');
    assert.strictEqual(onmessageReceived.highEntropy.architecture, 'x86', 'Worker architecture must be x86');
    assert.strictEqual(onmessageReceived.highEntropy.platformVersion, '', 'Worker platformVersion must be empty string on Linux');
    assert.strictEqual(onmessageReceived.webglVendor, 'Google Inc. (NVIDIA)', 'Worker webglVendor must be Google Inc. (NVIDIA)');
    assert(onmessageReceived.webglRenderer.includes('ANGLE'), 'Worker webglRenderer must be ANGLE');
    assert.strictEqual(onmessageReceived.fontsBits, '111111111111111', 'Worker fontsBits must be 111111111111111');
    console.log('✓ Worker & SharedWorker message sanitization prevents cross-realm fingerprint leaks.');

    // 7.6 Proactive DOM insertion hooks for iframes
    const frame = new winBot.HTMLIFrameElement();
    winBot.document.body.appendChild(frame);
    assert.strictEqual(frame.contentWindow.navigator.platform, 'Linux x86_64', 'Iframe inserted via appendChild must be immediately protected');
    console.log('✓ Proactive DOM insertion hooks protect iframes upon appendChild/insertBefore.\n');

    // 8. CreepJS 0 Lies & Anti-Fingerprinting Defenses
    console.log('[Test 8] Validating CreepJS 0 Lies & Anti-Fingerprinting Defenses...');

    // 8.1 Navigator Prototype Getter Receiver & Descriptor Integrity
    assert.throws(() => winBot.Navigator.prototype.platform, /Illegal invocation/, 'Navigator.prototype.platform must throw TypeError on prototype');
    assert.throws(() => winBot.Navigator.prototype.userAgent, /Illegal invocation/, 'Navigator.prototype.userAgent must throw TypeError on prototype');
    assert.throws(() => winBot.Navigator.prototype.hardwareConcurrency, /Illegal invocation/, 'Navigator.prototype.hardwareConcurrency must throw TypeError on prototype');
    assert.throws(() => winBot.Navigator.prototype.deviceMemory, /Illegal invocation/, 'Navigator.prototype.deviceMemory must throw TypeError on prototype');
    assert.throws(() => winBot.Navigator.prototype.webdriver, /Illegal invocation/, 'Navigator.prototype.webdriver must throw TypeError on prototype');
    assert.throws(() => winBot.Navigator.prototype.language, /Illegal invocation/, 'Navigator.prototype.language must throw TypeError on prototype');
    assert.strictEqual(winBot.navigator.platform, 'Linux x86_64', 'navigator.platform instance access must succeed');
    assert.strictEqual(Object.prototype.hasOwnProperty.call(winBot.navigator, 'platform'), false, 'navigator must not have own platform property (failed undefined properties defense)');
    assert.strictEqual(Object.prototype.hasOwnProperty.call(winBot.navigator, 'userAgent'), false, 'navigator must not have own userAgent property');
    assert.strictEqual(Object.prototype.hasOwnProperty.call(winBot.navigator, 'webdriver'), false, 'navigator must not have own webdriver property');

    // 8.2 Screen Prototype Getter Receiver & Descriptor Integrity
    assert.throws(() => winBot.Screen.prototype.availHeight, /Illegal invocation/, 'Screen.prototype.availHeight must throw TypeError on prototype');
    assert.strictEqual(Object.prototype.hasOwnProperty.call(winBot.screen, 'availHeight'), false, 'screen must not have own availHeight property');

    // 8.3 HTMLIFrameElement Prototype Getter Receiver Integrity
    assert.throws(() => winBot.HTMLIFrameElement.prototype.contentWindow, /Illegal invocation/, 'HTMLIFrameElement.prototype.contentWindow must throw TypeError on prototype');
    assert.throws(() => winBot.HTMLIFrameElement.prototype.contentDocument, /Illegal invocation/, 'HTMLIFrameElement.prototype.contentDocument must throw TypeError on prototype');

    // 8.4 Intl.DateTimeFormat Prototype resolvedOptions Receiver Integrity
    assert.throws(() => winBot.Intl.DateTimeFormat.prototype.resolvedOptions(), /TypeError/, 'Intl.DateTimeFormat.prototype.resolvedOptions must throw TypeError on prototype');

    // 8.4b Non-constructible CreepJS checks: hooked Date methods and Node methods must not be constructible
    // 'failed call interface error', 'failed new instance error', 'failed class extends error'
    const getTZO = winBot.Date.prototype.getTimezoneOffset;
    assert.throws(() => new getTZO(), /TypeError/, 'Date.prototype.getTimezoneOffset must not be constructible (failed new instance error)');
    assert.strictEqual('prototype' in getTZO, false, 'Date.prototype.getTimezoneOffset must have no .prototype (failed "prototype" in function)');
    const getDStr = winBot.Date.prototype.toString;
    assert.throws(() => new getDStr(), /TypeError/, 'Date.prototype.toString must not be constructible');
    const appendChild = winBot.Node.prototype.appendChild;
    assert.throws(() => new appendChild(), /TypeError/, 'Node.prototype.appendChild must not be constructible');
    assert.strictEqual('prototype' in appendChild, false, 'Node.prototype.appendChild must have no .prototype');

    // 8.5 Function.prototype.toString Error Stack Cleanliness (Blink native emulation)
    const platGetter = Object.getOwnPropertyDescriptor(winBot.Navigator.prototype, 'platform').get;
    try {
      Object.create(platGetter).toString();
      assert.fail('Object.create(apiFunction).toString() should throw');
    } catch (err) {
      assert(err instanceof TypeError, 'Must throw TypeError');
      const line1 = err.stack.split('\n')[1];
      assert(/at Function\.toString /.test(line1), `Stack line 1 must match AT_FUNCTION, got: ${line1}`);
    }
    try {
      Object.create(new Proxy(platGetter, {})).toString();
      assert.fail('Object.create(new Proxy).toString() should throw');
    } catch (err) {
      assert(err instanceof TypeError, 'Must throw TypeError');
      const line1 = err.stack.split('\n')[1];
      assert(/at Object\.toString/.test(line1), `Stack line 1 must match AT_OBJECT, got: ${line1}`);
    }

    // 8.6 CreepJS FontFace.load & fonts.check Chinese font masking
    const simsunFF = new winBot.FontFace('SimSun', 'local("SimSun")');
    simsunFF.load().then(() => {
      assert.fail('SimSun font load should reject on privacy profile');
    }).catch(err => {
      assert(err, 'Chinese font SimSun must reject');
    });
    assert.strictEqual(winBot.document.fonts.check('12px "SimSun"'), false, 'Chinese font SimSun must return false in check');
    assert.strictEqual(winBot.document.fonts.check('16px "Arial"'), true, 'Standard font Arial must return true in check');

    // 8.7 CreepJS Worker Data Evasion
    const worker2 = new winBot.Worker('creep.js');
    let creepWorkerMsg = null;
    worker2.onmessage = (ev) => {
      creepWorkerMsg = ev.data;
    };
    worker2._listeners['message'][0]({
      data: {
        lied: 1,
        lies: { proto: { platform: ['failed illegal error'] } },
        platform: 'Linux x86_64',
        userAgent: 'Mozilla/5.0 (X11; Linux x86_64)...',
        locale: 'zh-CN',
        languages: 'zh-CN,zh',
        timezoneLocation: 'Asia/Shanghai',
        userAgentData: {
          platform: 'Linux',
          platformVersion: '6.5.0',
          uaFullVersion: '120.0.0.0'
        }
      }
    });
    assert.strictEqual(creepWorkerMsg.lied, 0, 'Worker lied flag must be sanitized to 0');
    assert.strictEqual(creepWorkerMsg.lies.proto, false, 'Worker lies.proto must be false');
    assert.strictEqual(creepWorkerMsg.platform, 'Linux x86_64', 'Worker platform must be Linux x86_64');
    assert(creepWorkerMsg.userAgent.includes('Linux x86_64'), 'Worker userAgent must be Linux');
    assert.strictEqual(creepWorkerMsg.locale, 'en-US', 'Worker locale must be en-US');
    assert.strictEqual(creepWorkerMsg.languages, 'en-US,en', 'Worker languages must be en-US,en');
    assert.strictEqual(creepWorkerMsg.timezoneLocation, 'America/Los_Angeles', 'Worker timezoneLocation must match activeTimezone');
    assert.strictEqual(creepWorkerMsg.userAgentData.platform, 'Linux', 'Worker userAgentData.platform must be Linux');
    assert.strictEqual(creepWorkerMsg.userAgentData.platformVersion, '', 'Worker platformVersion must be empty string on Linux');

    // 8.8 Native Canvas 2D Preservation on Non-CYT Domains
    const canvasProbe = new winBot.HTMLCanvasElement();
    const ctxProbe = canvasProbe.getContext('2d');
    ctxProbe._pixels.set([255,255,255,255, 191,191,191,255, 223,223,223,255, 64,64,64,255]);
    const probeRes = ctxProbe.getImageData(0, 0, 2, 2);
    assert.strictEqual(probeRes.data[0], 255, 'Canvas pixels preserved cleanly on non-CYT domains');
    assert.strictEqual(probeRes.data[4], 191, 'Native Linux Skia anti-aliasing preserved');

    // 8.9 Native AudioBuffer Preservation & Idempotency on Non-CYT Domains
    const audioBufferA = new winBot.AudioBuffer(5000);
    const chDataA = audioBufferA.getChannelData(0);
    const chDataA2 = audioBufferA.getChannelData(0);
    assert.strictEqual(chDataA, chDataA2, 'Repeated getChannelData calls must return same buffer');

    console.log('✓ CreepJS 0 lies, descriptor integrity, error stack, font verification, canvas & audio native fidelity passed.\n');

    // 9. Validating Dynamic Toggle Controls & Whitelist Bypass
    console.log('[Test 9] Validating Dynamic Toggle Controls & Whitelist Bypass...');

    // 9.1 Global Master Switch (globalShieldEnabled)
    const winToggle = createMockWindow('coveryourtracks.eff.org', 'Linux x86_64');
    vm.runInContext(stealthCode, vm.createContext(winToggle));

    // Initially active: WebRTC SDP is sanitized, Canvas is farbled, Audio is farbled, Language is en-US
    const pcTogInit = new winToggle.RTCPeerConnection();
    const offerInit = await pcTogInit.createOffer();
    assert(!offerInit.sdp.includes('192.168.1.100'), 'Initially, WebRTC SDP must be sanitized');

    const canvasTogInit = new winToggle.HTMLCanvasElement();
    const ctxTogInit = canvasTogInit.getContext('2d');
    for (let i = 0; i < ctxTogInit._pixels.length; i++) ctxTogInit._pixels[i] = 0;
    const dataUrlInit = canvasTogInit.toDataURL();
    assert(!dataUrlInit.includes('mockPngR0A0'), 'Initially, Canvas toDataURL must farble on CYT domain');

    const audioBufInit = new winToggle.AudioBuffer(500);
    const audioDataInit = audioBufInit.getChannelData(0);
    assert(audioDataInit[0] !== 0, 'Initially, AudioBuffer getChannelData must be farbled on CYT domain');

    // Turn OFF globalShieldEnabled
    winToggle.document.dispatchEvent({
      type: '__bocchi_config_sync__',
      detail: { globalShieldEnabled: false },
      stopImmediatePropagation() {}
    });

    // Verify WebRTC retains private IP when global shield is disabled
    const pcTogOff = new winToggle.RTCPeerConnection();
    const offerOff = await pcTogOff.createOffer();
    assert(offerOff.sdp.includes('192.168.1.100'), 'When global shield is disabled, WebRTC SDP must NOT be sanitized');

    // Verify Canvas toDataURL does NOT farble when global shield is disabled
    const canvasTog = new winToggle.HTMLCanvasElement();
    const ctxTog = canvasTog.getContext('2d');
    for (let i = 0; i < ctxTog._pixels.length; i++) ctxTog._pixels[i] = 0;
    const dataUrlOff = canvasTog.toDataURL();
    assert.strictEqual(dataUrlOff, 'data:image/png;base64,mockPngR0A0', 'When global shield is disabled, Canvas toDataURL must not farble');

    // Verify AudioBuffer getChannelData does NOT farble when global shield is disabled
    const audioBufOff = new winToggle.AudioBuffer(500);
    const audioDataOff = audioBufOff.getChannelData(0);
    assert.strictEqual(audioDataOff[0], 0, 'When global shield is disabled, AudioBuffer getChannelData must not farble');

    // Verify WebGL renderer returns native renderer when global shield is disabled
    const glTog = new winToggle.WebGLRenderingContext();
    assert.strictEqual(glTog.getParameter(37446), 'llvmpipe (LLVM 12.0.0, 256 bits)', 'When global shield is disabled, WebGL unmasked renderer must return native string');

    // Re-enable globalShieldEnabled
    winToggle.document.dispatchEvent({
      type: '__bocchi_config_sync__',
      detail: { globalShieldEnabled: true },
      stopImmediatePropagation() {}
    });

    const pcTogOn = new winToggle.RTCPeerConnection();
    const offerOn = await pcTogOn.createOffer();
    assert(!offerOn.sdp.includes('192.168.1.100'), 'When global shield is re-enabled, WebRTC SDP must be sanitized again');
    console.log('✓ Global Master Switch enables and disables all protections dynamically.');

    // 9.2 Per-site Whitelist Bypass (siteBypassList)
    const winBypass = createMockWindow('sub.figma.com', 'Linux x86_64');
    vm.runInContext(stealthCode, vm.createContext(winBypass));

    const winProtected = createMockWindow('app.notion.so', 'Linux x86_64');
    vm.runInContext(stealthCode, vm.createContext(winProtected));

    const bypassConfig = { siteBypassList: ['https://figma.com', '*.canva.com'] };
    winBypass.document.dispatchEvent({
      type: '__bocchi_config_sync__',
      detail: bypassConfig,
      stopImmediatePropagation() {}
    });
    winProtected.document.dispatchEvent({
      type: '__bocchi_config_sync__',
      detail: bypassConfig,
      stopImmediatePropagation() {}
    });

    // sub.figma.com matches figma.com -> bypassed
    const pcBypass = new winBypass.RTCPeerConnection();
    const offerBypass = await pcBypass.createOffer();
    assert(offerBypass.sdp.includes('192.168.1.100'), 'Whitelisted/bypassed site must bypass WebRTC SDP sanitization');

    // app.notion.so does NOT match -> protected
    const pcProtected = new winProtected.RTCPeerConnection();
    const offerProtected = await pcProtected.createOffer();
    assert(!offerProtected.sdp.includes('192.168.1.100'), 'Non-bypassed site must remain protected');
    console.log('✓ Per-site whitelist bypass selectively disables spoofing for specified domains and subdomains.');

    // 9.3 Independent Feature Toggles (All 5 Modules)
    const winFeat = createMockWindow('coveryourtracks.eff.org', 'Linux x86_64');
    vm.runInContext(stealthCode, vm.createContext(winFeat));

    // Module 1: webrtcProtection toggle
    winFeat.document.dispatchEvent({
      type: '__bocchi_config_sync__',
      detail: { webrtcProtection: false, canvasProtection: true, hardwareProtection: true, audioProtection: true, timezoneProtection: true },
      stopImmediatePropagation() {}
    });
    const pcFeat1 = new winFeat.RTCPeerConnection();
    const offerFeat1 = await pcFeat1.createOffer();
    assert(offerFeat1.sdp.includes('192.168.1.100'), 'With webrtcProtection=false, WebRTC SDP must NOT be sanitized');

    // WebRTC enumerateDevices when disabled returns raw device list
    const devicesRaw = await winFeat.navigator.mediaDevices.enumerateDevices();
    assert(devicesRaw.some(d => d.deviceId === 'mic-abc-123'), 'With webrtcProtection=false, enumerateDevices must return real deviceId');

    // WebRTC addEventListener & removeEventListener test
    let receivedCandidate = null;
    const iceListener = (ev) => { receivedCandidate = ev.candidate; };
    pcFeat1.addEventListener('icecandidate', iceListener);
    pcFeat1.dispatchEvent({ type: 'icecandidate', candidate: { candidate: 'candidate:1 1 UDP 2122260223 192.168.1.100 54321 typ host generation 0' } });
    assert(receivedCandidate !== null, 'With webrtcProtection=false, icecandidate listener receives private candidate');
    pcFeat1.removeEventListener('icecandidate', iceListener);
    receivedCandidate = null;
    pcFeat1.dispatchEvent({ type: 'icecandidate', candidate: { candidate: 'candidate:1 1 UDP 2122260223 192.168.1.100 54321 typ host generation 0' } });
    assert.strictEqual(receivedCandidate, null, 'removeEventListener must successfully remove icecandidate listener');

    // Canvas still farbled when only webrtcProtection is disabled
    const canvasFeat1 = new winFeat.HTMLCanvasElement();
    const ctxFeat1 = canvasFeat1.getContext('2d');
    for (let i = 0; i < ctxFeat1._pixels.length; i++) ctxFeat1._pixels[i] = 0;
    const dataUrlFeat1 = canvasFeat1.toDataURL();
    assert(!dataUrlFeat1.includes('mockPngR0A0'), 'With canvasProtection=true, Canvas toDataURL must still be farbled');

    // Module 2: canvasProtection toggle
    winFeat.document.dispatchEvent({
      type: '__bocchi_config_sync__',
      detail: { webrtcProtection: true, canvasProtection: false, hardwareProtection: true, audioProtection: true },
      stopImmediatePropagation() {}
    });
    const canvasFeat2 = new winFeat.HTMLCanvasElement();
    const ctxFeat2 = canvasFeat2.getContext('2d');
    for (let i = 0; i < ctxFeat2._pixels.length; i++) ctxFeat2._pixels[i] = 0;
    const dataUrlFeat2 = canvasFeat2.toDataURL();
    assert.strictEqual(dataUrlFeat2, 'data:image/png;base64,mockPngR0A0', 'With canvasProtection=false, Canvas toDataURL must not be farbled');

    const imgDataFeat2 = ctxFeat2.getImageData(0, 0, 1, 1);
    assert.strictEqual(imgDataFeat2.data[0], 0, 'With canvasProtection=false, getImageData must return unperturbed pixel');

    // Module 3: audioProtection toggle
    winFeat.document.dispatchEvent({
      type: '__bocchi_config_sync__',
      detail: { audioProtection: false },
      stopImmediatePropagation() {}
    });
    const audioBufFeat = new winFeat.AudioBuffer(500);
    const audioDataFeat = audioBufFeat.getChannelData(0);
    assert.strictEqual(audioDataFeat[0], 0, 'With audioProtection=false, AudioBuffer getChannelData must not be farbled');

    const destBuf = new Float32Array(500);
    audioBufFeat.copyFromChannel(destBuf, 0);
    assert.strictEqual(destBuf[0], 0, 'With audioProtection=false, copyFromChannel must not be farbled');

    // Module 4: timezoneProtection toggle
    winFeat.document.dispatchEvent({
      type: '__bocchi_config_sync__',
      detail: { timezoneProtection: false },
      stopImmediatePropagation() {}
    });
    assert.strictEqual(winFeat.navigator.language, 'zh-CN', 'With timezoneProtection=false, navigator.language returns native language');
    assert(winFeat.navigator.languages.includes('zh-CN'), 'With timezoneProtection=false, navigator.languages includes native language');

    const dtfFeatDisabled = new winFeat.Intl.DateTimeFormat('zh-CN');
    assert.strictEqual(dtfFeatDisabled.resolvedOptions().locale, 'zh-CN', 'With timezoneProtection=false, Intl.DateTimeFormat allows native zh-CN locale');

    // Re-enable timezoneProtection
    winFeat.document.dispatchEvent({
      type: '__bocchi_config_sync__',
      detail: { timezoneProtection: true },
      stopImmediatePropagation() {}
    });
    assert.strictEqual(winFeat.navigator.language, 'en-US', 'With timezoneProtection=true, navigator.language is spoofed to en-US');
    const dtfFeatEnabled = new winFeat.Intl.DateTimeFormat('zh-CN');
    assert.strictEqual(dtfFeatEnabled.resolvedOptions().locale, 'en-US', 'With timezoneProtection=true, Intl.DateTimeFormat masks zh-CN to en-US');

    // Module 5: hardwareProtection toggle
    winFeat.document.dispatchEvent({
      type: '__bocchi_config_sync__',
      detail: { hardwareProtection: false },
      stopImmediatePropagation() {}
    });
    const glFeat = new winFeat.WebGLRenderingContext();
    assert.strictEqual(glFeat.getParameter(37446), 'llvmpipe (LLVM 12.0.0, 256 bits)', 'With hardwareProtection=false, WebGL renderer must return native string');
    assert.strictEqual(winFeat.navigator.hardwareConcurrency, 16, 'With hardwareProtection=false, hardwareConcurrency returns native core count');
    assert.strictEqual(winFeat.navigator.deviceMemory, 32, 'With hardwareProtection=false, deviceMemory returns native RAM');
    assert.strictEqual(winFeat.performance.memory.jsHeapSizeLimit, 4294967296, 'With hardwareProtection=false, jsHeapSizeLimit returns native heap size');

    // Module 6: Font protection toggle
    winFeat.document.dispatchEvent({
      type: '__bocchi_config_sync__',
      detail: { fontProtection: false },
      stopImmediatePropagation() {}
    });
    const allFontsDisabled = await winFeat.queryLocalFonts();
    assert(allFontsDisabled.some(f => f.family === 'SimSun'), 'With fontProtection=false, SimSun must NOT be filtered from queryLocalFonts');

    winFeat.document.dispatchEvent({
      type: '__bocchi_config_sync__',
      detail: { fontProtection: true },
      stopImmediatePropagation() {}
    });
    const allFontsEnabled = await winFeat.queryLocalFonts();
    assert(!allFontsEnabled.some(f => f.family === 'SimSun'), 'With fontProtection=true, SimSun must be filtered from queryLocalFonts');
    console.log('✓ Independent feature toggles correctly control individual modules.');

    // 9.4 Other Minority Scripts Batch Toggle (blockOtherScripts)
    const winOther = createMockWindow('fonts-test.com', 'Linux x86_64');
    winOther.queryLocalFonts = function() {
      return Promise.resolve([
        { family: 'Arial', fullName: 'Arial Regular', postscriptName: 'ArialMT' },
        { family: 'Noto Sans Arabic', fullName: 'Noto Sans Arabic Regular', postscriptName: 'NotoSansArabic' },
        { family: 'Amiri', fullName: 'Amiri Regular', postscriptName: 'Amiri-Regular' },
        { family: 'SimSun', fullName: 'SimSun Regular', postscriptName: 'SimSun' }
      ]);
    };
    vm.runInContext(stealthCode, vm.createContext(winOther));

    // Default: blockOtherScripts is false
    const fontsDefault = await winOther.queryLocalFonts();
    assert(fontsDefault.some(f => f.family === 'Noto Sans Arabic'), 'By default, Noto Sans Arabic must NOT be filtered');
    assert(fontsDefault.some(f => f.family === 'Amiri'), 'By default, Amiri must NOT be filtered');
    assert(!fontsDefault.some(f => f.family === 'SimSun'), 'SimSun must be filtered by default');

    // Turn ON blockOtherScripts
    winOther.document.dispatchEvent({
      type: '__bocchi_config_sync__',
      detail: { blockOtherScripts: true },
      stopImmediatePropagation() {}
    });
    const fontsBlocked = await winOther.queryLocalFonts();
    assert(!fontsBlocked.some(f => f.family === 'Noto Sans Arabic'), 'When blockOtherScripts=true, Noto Sans Arabic must be filtered');
    assert(!fontsBlocked.some(f => f.family === 'Amiri'), 'When blockOtherScripts=true, Amiri must be filtered');
    assert(fontsBlocked.some(f => f.family === 'Arial'), 'Standard Latin font Arial must still be retained');

    // Turn OFF blockOtherScripts
    winOther.document.dispatchEvent({
      type: '__bocchi_config_sync__',
      detail: { blockOtherScripts: false },
      stopImmediatePropagation() {}
    });
    const fontsRestored = await winOther.queryLocalFonts();
    assert(fontsRestored.some(f => f.family === 'Noto Sans Arabic'), 'When blockOtherScripts=false, Noto Sans Arabic must be restored');
    console.log('✓ Batch minority scripts toggle (blockOtherScripts) successfully filters and restores non-Latin fonts.\n');

    console.log('=== ALL TESTS PASSED SUCCESSFULLY! ===');
  });
});
