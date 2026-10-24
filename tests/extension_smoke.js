#!/usr/bin/env node
'use strict';

/**
 * Real-browser smoke test for the actual extension registration/injection
 * path. Requires a Chromium/Chrome for Testing binary that honors
 * --load-extension (set CHROME_BIN). Unlike the unit suite, this exercises the
 * service worker, dynamic content-script registration, the bridge handshake and
 * the MAIN-world engine on a local HTTP page.
 *
 * Run: CHROME_BIN=/path/to/chrome node tests/extension_smoke.js
 *
 * Every navigation is polled to a settled state and asserted (URL,
 * readyState, page probe) before any behavior is measured; fixed sleeps are
 * only used inside polling loops. A page that never loads (e.g. an error
 * page) therefore fails instead of turning `undefined` into a passing
 * assertion.
 */

const assert = require('assert');
const http = require('http');
const h = require('./lib/live_harness');

const PAGE = `<!doctype html><html><body><canvas id="probe-canvas"></canvas><script>
window.__probe = async function () {
  const numeric = new Date(2025, 0, 1).getTime();
  const str = new Date('2025-01-01T00:00:00').getTime();
  const parsed = Date.parse('2025-01-01T00:00:00');
  const utc = new Date('2025-01-01T00:00:00Z').getTime();
  const dateDesc = Object.getOwnPropertyDescriptor(window, 'Date');
  const dateProtoDesc = Object.getOwnPropertyDescriptor(Date, 'prototype');
  const c = document.createElement('canvas');
  c.width = 300; c.height = 300;
  const g = c.getContext('2d');
  g.fillStyle = 'rgb(200,10,10)'; g.fillRect(0, 0, 300, 300);
  const blobPromise = new Promise(resolve => c.toBlob(function (blob) {
    // canvas2dPixels is disabled for this assertion so this read is native.
    const after = Array.from(g.getImageData(125, 1, 1, 1).data);
    resolve({ blob: !!blob, after });
  }, 'image/png'));
  g.clearRect(0, 0, 300, 300);
  const blob = await blobPromise;
  return {
    numeric, str, parsed, utc,
    dateDiff: str - numeric,
    parseDiff: parsed - str,
    tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
    dateEnumerable: !!(dateDesc && dateDesc.enumerable),
    dateProtoWritable: !!(dateProtoDesc && dateProtoDesc.writable),
    dateChain: Object.getPrototypeOf(Date) === Object.getPrototypeOf(function () {}),
    gumLength: navigator.mediaDevices && navigator.mediaDevices.getUserMedia
      ? navigator.mediaDevices.getUserMedia.length : 'missing',
    rtcIsAccessor: (() => {
      const d = Object.getOwnPropertyDescriptor(window, 'RTCPeerConnection');
      return !!(d && typeof d.get === 'function');
    })(),
    blob
  };
};

window.__pngProfile = async function (ctxOptions) {
  const c = document.createElement('canvas');
  c.width = 32; c.height = 32;
  const g = c.getContext('2d', ctxOptions);
  g.fillStyle = 'rgb(200,10,10)'; g.fillRect(0, 0, 32, 32);
  const blob = await new Promise(resolve => c.toBlob(resolve, 'image/png'));
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let colorType = null;
  let hasICCP = false;
  for (let i = 8; i < bytes.length - 8;) {
    const len = (bytes[i] << 24) | (bytes[i + 1] << 16) | (bytes[i + 2] << 8) | bytes[i + 3];
    const type = String.fromCharCode(bytes[i + 4], bytes[i + 5], bytes[i + 6], bytes[i + 7]);
    if (type === 'IHDR') colorType = bytes[i + 17];
    if (type === 'iCCP') hasICCP = true;
    i += 12 + len;
  }
  return { colorType, hasICCP };
};

window.__fontProbe = function (allowed, prefix) {
  return {
    allowed: document.fonts.check('16px "' + allowed + '"'),
    prefix: document.fonts.check('16px "' + prefix + '"')
  };
};

window.__rtcProbe = function () {
  const d = Object.getOwnPropertyDescriptor(window, 'RTCPeerConnection');
  return {
    rtc: typeof window.RTCSessionDescription,
    accessor: !!(d && typeof d.get === 'function'),
    enumerable: !!(d && d.enumerable)
  };
};

window.__workerProbe = function () {
  return new Promise((resolve, reject) => {
    const worker = new Worker('/worker.js');
    const timer = setTimeout(() => {
      worker.terminate();
      reject(new Error('worker probe timed out'));
    }, 7000);
    worker.onmessage = event => {
      clearTimeout(timer);
      worker.terminate();
      resolve(event.data);
    };
    worker.onerror = event => {
      clearTimeout(timer);
      worker.terminate();
      reject(new Error(event.message || 'worker error'));
    };
    worker.postMessage('probe');
  });
};
</script></body></html>`;

const WORKER = `
self.onmessage = function () {
  try {
    const d = new Date(0);
    const dtf = new Intl.DateTimeFormat('en-US', { timeZoneName: 'long' });
    const parts = dtf.formatToParts(new Date(0));
    const oc = new OffscreenCanvas(300, 150);
    const g = oc.getContext('2d');
    g.fillStyle = 'rgb(255,0,0)';
    g.fillRect(0, 0, 300, 150);
    const pixels = g.getImageData(0, 0, 1, 1).data;
    self.postMessage({
      hours: d.getHours(),
      offset: d.getTimezoneOffset(),
      tz: new Intl.DateTimeFormat().resolvedOptions().timeZone,
      tzName: (parts.find(p => p.type === 'timeZoneName') || {}).value || null,
      pixels: Array.from(pixels)
    });
  } catch (err) {
    self.postMessage({ error: String(err && err.stack || err) });
  }
};
`;

const ENGINE_MARK = "typeof window[Symbol.for('__bpc_pm_7e4b1c92')]";

// The font prefix check is only meaningful with a real prefix pair installed;
// CI installs fonts-noto-core and this test fails rather than skipping when
// the fonts are missing.
const FONT_PAIR = { allowed: 'Noto Sans', prefix: 'Noto Sans Arabic' };

/**
 * Poll a predicate until it returns truthy. Errors thrown while evaluating
 * during a navigation are treated as "not ready yet" (the context may be
 * destroyed mid-commit), so an error page fails on the final assertion rather
 * than crashing the poll with a misleading transient error.
 */
async function waitFor(predicate, label, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      if (await predicate()) return;
    } catch (err) {
      lastError = err;
    }
    await h.sleep(100);
  }
  throw new Error(`Timed out waiting for ${label}` +
    (lastError ? ` (last error: ${lastError.message})` : ''));
}

async function run() {
  const server = http.createServer((req, res) => {
    if (req.url === '/worker.js') {
      res.writeHead(200, { 'content-type': 'application/javascript; charset=utf-8' });
      res.end(WORKER);
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(PAGE);
  });
  const port = await h.freePort();
  await new Promise(resolve => server.listen(port, '127.0.0.1', resolve));

  try {
    await h.runWithRetry('extension-smoke', {}, async (ctx) => {
      const cdp = ctx.cdp;
      await cdp.send('Page.enable');
      await cdp.send('Runtime.enable');

      const evaluate = async (expression) => {
        const result = await cdp.send('Runtime.evaluate', {
          expression, returnByValue: true, awaitPromise: true
        });
        if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
        return result.result && result.result.value;
      };

      const listTargets = async () => {
        const res = await fetch(`http://127.0.0.1:${ctx.port}/json/list`);
        return res.json();
      };

      // The service worker target can appear after the first /json/list
      // response (extension startup is asynchronous), so poll instead of
      // sampling once.
      await waitFor(async () => {
        const targets = await listTargets();
        return Array.isArray(targets) && targets.some(t =>
          t.type === 'service_worker' && /background\/service_worker\.js$/.test(t.url || ''));
      }, 'extension service worker target');

      const targets = await listTargets();
      const sw = (targets || []).find(t =>
        t.type === 'service_worker' && t.url.includes('/background/service_worker.js'));
      assert(sw, 'The extension service worker must be loaded');
      const idMatch = sw.url.match(/chrome-extension:\/\/([^/]+)/);
      assert(idMatch, `service worker URL must contain an extension id (got ${sw.url})`);
      const id = idMatch[1];
      const panelUrl = `chrome-extension://${id}/panel/panel.html`;

      // Drive configuration from the service worker, not the panel: the panel
      // sanitizes siteBypassList on load/change, so a malformed entry written
      // from the panel would never reach the registration path the smoke test
      // is meant to exercise.
      const swCdp = new h.CDPClient(sw.webSocketDebuggerUrl);
      await swCdp.open();
      await swCdp.send('Runtime.enable');
      const swEvaluate = async (expression) => {
        const result = await swCdp.send('Runtime.evaluate', {
          expression, returnByValue: true, awaitPromise: true
        });
        if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
        return result.result && result.result.value;
      };

      // Open the panel and wait for the document plus the font API the font
      // assertion relies on; a fixed sleep can race panel startup.
      const openPanel = async () => {
        await cdp.send('Page.navigate', { url: panelUrl });
        await waitFor(async () => {
          const state = await evaluate(`({
            href: location.href.replace(/#.*$/, ''),
            ready: document.readyState,
            api: typeof chrome !== 'undefined' &&
              !!(chrome.fontSettings && chrome.fontSettings.getFontList)
          })`);
          return state && state.href === panelUrl && state.ready === 'complete' && state.api === true;
        }, 'panel page plus chrome.fontSettings');
        const settled = await evaluate(
          '({ href: location.href.replace(/#.*$/, ""), ready: document.readyState })'
        );
        assert.strictEqual(settled.href, panelUrl, 'panel navigation must land on panel.html');
        assert.strictEqual(settled.ready, 'complete', 'panel document must be complete');
      };

      // Write storage, read it back, and require the exact values. This makes
      // a failed chrome.storage write visible instead of silently testing the
      // previous configuration.
      const setStorage = async (values) => {
        const keys = Object.keys(values);
        await swEvaluate(`new Promise((resolve, reject) => chrome.storage.local.set(${JSON.stringify(values)}, () => {
          if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
          else resolve(true);
        }))`);
        const stored = await swEvaluate(
          `new Promise(resolve => chrome.storage.local.get(${JSON.stringify(keys)}, resolve))`
        );
        assert(stored && typeof stored === 'object', 'chrome.storage.local.get must return an object');
        for (const key of keys) {
          assert.deepStrictEqual(stored[key], values[key], `storage readback mismatch for ${key}`);
        }
      };

      const getRegisteredScripts = () => swEvaluate('chrome.scripting.getRegisteredContentScripts()');
      const waitForRegistration = (check, label) =>
        waitFor(async () => check(await getRegisteredScripts()), label);

      // Poll to a complete document that is either the expected URL or a
      // Chrome error page; the assertion below then reports the actual URL
      // instead of letting an unfinished/error document look like "no engine".
      const readPageState = () => evaluate(`({
        href: location.href,
        ready: document.readyState,
        probe: typeof window.__probe
      })`);
      const isSettled = (state, url) => !!state && state.ready === 'complete' &&
        (state.href === url || String(state.href).startsWith('chrome-error://'));

      // Site page navigation: poll to a complete document with the page probe
      // installed, assert that state, then wait for the engine AND for the
      // bridge-delivered config (manual Asia/Tokyo timezone) to be observable.
      const openPage = async (host = '127.0.0.1') => {
        const url = `http://${host}:${port}/`;
        await cdp.send('Page.navigate', { url });
        await waitFor(async () => isSettled(await readPageState(), url),
          `page ${url} to finish loading`);
        const settled = await readPageState();
        assert.strictEqual(settled.href, url, `navigation must land on ${url}, not an error page`);
        assert.strictEqual(settled.ready, 'complete', `${url} must finish loading`);
        assert.strictEqual(settled.probe, 'function', `${url} must serve the test page probe`);
        await waitFor(async () => (await evaluate(ENGINE_MARK)) === 'object',
          `engine injection on ${url}`);
        await waitFor(async () =>
          (await evaluate('Intl.DateTimeFormat().resolvedOptions().timeZone')) === 'Asia/Tokyo',
        `bridge config (Asia/Tokyo) on ${url}`);
      };

      // Site page navigation that must end with the engine absent (bypass or
      // global off). The document itself must still load normally.
      const openPageWithoutEngine = async (host, label) => {
        const url = `http://${host}:${port}/`;
        await cdp.send('Page.navigate', { url });
        await waitFor(async () => isSettled(await readPageState(), url),
          `${label}: ${url} to finish loading`);
        const settled = await readPageState();
        assert.strictEqual(settled.href, url, `${label}: must land on ${url}, not an error page`);
        assert.strictEqual(settled.ready, 'complete', `${label}: ${url} must finish loading`);
        assert.strictEqual(settled.probe, 'function', `${label}: test page probe must exist`);
        assert.strictEqual(await evaluate(ENGINE_MARK), 'undefined',
          `${label}: engine must not be injected into ${url}`);
      };

      await openPanel();
      const installedFonts = await evaluate(
        'chrome.fontSettings.getFontList().then(list => list.map(f => f.displayName).filter(Boolean))'
      );
      assert(Array.isArray(installedFonts), 'chrome.fontSettings.getFontList must return an array');
      assert(installedFonts.includes(FONT_PAIR.allowed),
        `font prefix regression test requires "${FONT_PAIR.allowed}" to be installed; CI installs fonts-noto-core`);
      assert(installedFonts.includes(FONT_PAIR.prefix),
        `font prefix regression test requires "${FONT_PAIR.prefix}" to be installed; CI installs fonts-noto-core`);

      // Manual timezone keeps the assertion deterministic even if the host has
      // network access to a GeoIP provider.
      await setStorage({
        globalShieldEnabled: true,
        timezoneProtection: true,
        timezoneMode: 'manual',
        manualTimezone: 'Asia/Tokyo',
        timezone: 'Asia/Tokyo',
        canvas2dPixels: false,
        canvas2dExport: true,
        fontProtection: false,
        languageProtection: false,
        siteBypassList: ['localhost'],
        webrtcBlockSupport: false,
        webrtcBlockObjects: false
      });

      await openPage();
      const base = await evaluate('window.__probe()');
      assert.strictEqual(base.tz, 'Asia/Tokyo', 'timezone spoof must reach the real page');
      assert.strictEqual(base.dateDiff, 0, 'Date string and numeric construction must agree');
      assert.strictEqual(base.parseDiff, 0, 'Date.parse must agree with the constructor');
      assert.strictEqual(base.utc, Date.UTC(2025, 0, 1), 'Explicit-Z strings must stay UTC');
      assert.strictEqual(base.dateEnumerable, false, 'Date global must be non-enumerable');
      assert.strictEqual(base.dateProtoWritable, false, 'Date.prototype descriptor must be non-writable');
      assert.strictEqual(base.dateChain, true, 'Date must inherit from Function.prototype');
      assert.strictEqual(base.gumLength, 0, 'getUserMedia.length must match native');
      assert.strictEqual(base.rtcIsAccessor, false, 'RTCPeerConnection must stay a data property when blocks are off');
      assert.strictEqual(base.blob.blob, true, 'toBlob must still produce a Blob');
      assert.deepStrictEqual(base.blob.after, [0, 0, 0, 0], 'toBlob must not restore stale pixels after clearRect');
      const opaqueProfile = await evaluate("window.__pngProfile({ alpha: false })");
      assert.strictEqual(opaqueProfile.colorType, 2, 'toBlob snapshot must preserve an alpha:false canvas (RGB PNG)');
      const p3Profile = await evaluate("window.__pngProfile({ colorSpace: 'display-p3' })");
      assert.strictEqual(p3Profile.hasICCP, true, 'toBlob snapshot must preserve a display-p3 color profile');

      await setStorage({ canvas2dPixels: true });
      await openPage();
      const worker = await evaluate('window.__workerProbe()');
      assert(!worker.error, `worker probe must not throw: ${worker.error || ''}`);
      assert.strictEqual(worker.hours, 9, 'Worker Date.getHours must use the bridge target timezone');
      assert.strictEqual(worker.offset, -540, 'Worker getTimezoneOffset must match the target zone');
      assert.strictEqual(worker.tz, 'Asia/Tokyo', 'Worker resolvedOptions must report the target zone');
      assert.strictEqual(worker.tzName, 'Japan Standard Time', 'Worker formatToParts must remain functional');
      assert(Array.isArray(worker.pixels) && worker.pixels.length === 4, 'Worker OffscreenCanvas must return pixels');
      assert(worker.pixels[0] !== 255 && worker.pixels[1] === 0 && worker.pixels[2] === 0 && worker.pixels[3] === 255,
        'Worker OffscreenCanvas 2D reads must be farbled like the main thread');

      // The font check is a hard requirement (this branch used to be a
      // silent skip). CI installs fonts-noto-core so both families exist.
      await setStorage({
        fontMode: 'whitelist',
        customAllowedFonts: [FONT_PAIR.allowed],
        customHiddenFonts: [],
        fontProtection: true
      });
      await openPage();
      const font = await evaluate(
        `window.__fontProbe(${JSON.stringify(FONT_PAIR.allowed)}, ${JSON.stringify(FONT_PAIR.prefix)})`
      );
      assert.strictEqual(font.allowed, true, 'Whitelisted font must remain visible');
      assert.strictEqual(font.prefix, false, 'A prefix-sharing font must not be implicitly whitelisted');

      await setStorage({ webrtcBlockSupport: true, webrtcBlockObjects: true });
      await openPage();
      const rtcOn = await evaluate('window.__rtcProbe()');
      assert.strictEqual(rtcOn.rtc, 'undefined', 'webrtcBlockSupport must hide RTCSessionDescription');
      assert.strictEqual(rtcOn.accessor, true, 'Active block must use a property accessor');
      assert.strictEqual(rtcOn.enumerable, false, 'WebRTC hiding accessor must be non-enumerable');

      await setStorage({ webrtcBlockSupport: false, webrtcBlockObjects: false });
      await openPage();
      const rtcOff = await evaluate('window.__rtcProbe()');
      assert.strictEqual(rtcOff.rtc, 'function', 'Turning blocks off must restore RTCSessionDescription');
      assert.strictEqual(rtcOff.accessor, false, 'Turning blocks off must restore the native data descriptor');

      // A malformed exception must not unregister both content scripts (the
      // safe fallback keeps protection available, with exclusions disabled).
      await setStorage({ siteBypassList: ['[a:b]'] });
      await waitForRegistration(
        list => Array.isArray(list) && list.length === 2 &&
          list.every(s => !Array.isArray(s.excludeMatches) || s.excludeMatches.length === 0),
        'content scripts registered without exclusions after a malformed IPv6 entry'
      );
      await openPage('127.0.0.1');
      assert.strictEqual(await evaluate(ENGINE_MARK), 'object',
        'A malformed IPv6 exception must not leave the protected page uninjected');
      // localhost was excluded by the previous configuration; the safe
      // fallback must have dropped every exclusion, so it is injected again.
      await openPage('localhost');
      assert.strictEqual(await evaluate(ENGINE_MARK), 'object',
        'localhost must be injected again after the malformed entry disables exclusions');

      // A bare public suffix must never become an exclusion pattern.
      await setStorage({ siteBypassList: ['com'] });
      await waitForRegistration(
        list => Array.isArray(list) && list.length === 2 &&
          list.every(s => !Array.isArray(s.excludeMatches) || s.excludeMatches.length === 0),
        'public suffix rejected by content-script registration'
      );
      await openPage('127.0.0.1');
      assert.strictEqual(await evaluate(ENGINE_MARK), 'object',
        'A bare public suffix must not disable protection');

      await setStorage({ siteBypassList: ['localhost'] });
      await waitForRegistration(
        list => Array.isArray(list) && list.length === 2 && list.every(s =>
          Array.isArray(s.excludeMatches) &&
          s.excludeMatches.includes('*://localhost/*') &&
          s.excludeMatches.includes('*://*.localhost/*')),
        'localhost exclusion registered on both content scripts'
      );
      await openPageWithoutEngine('localhost', 'bypass');

      // Global off removes injection entirely, so even a document_start inline
      // script cannot observe an inert engine or a fail-closed canvas hook.
      await setStorage({ globalShieldEnabled: false });
      await waitForRegistration(
        list => Array.isArray(list) && list.length === 0,
        'content scripts unregistered for global off'
      );
      await openPageWithoutEngine('127.0.0.1', 'global off');

      await setStorage({ globalShieldEnabled: true });
      await waitForRegistration(
        list => Array.isArray(list) && list.length === 2,
        'content scripts re-registered after global on'
      );

      console.log('EXTENSION SMOKE PASSED');
    });
  } finally {
    server.close();
  }
}

run().catch((err) => {
  console.error('EXTENSION SMOKE FAILED:', err && err.stack ? err.stack : err);
  process.exitCode = 1;
});
