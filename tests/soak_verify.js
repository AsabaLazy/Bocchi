#!/usr/bin/env node
'use strict';

/**
 * tests/soak_verify.js — Long-running leak check for the extension.
 *
 * Loads the extension in headless Chrome (Chromium / Chrome for Testing),
 * drives a continuous mixed workload (canvas exports, audio buffers, worker
 * spawn/terminate, iframe churn, font/layout probes) and samples RETAINED
 * memory every minute (HeapProfiler.collectGarbage before each sample, so
 * garbage in flight is not mistaken for a leak). Every 5 minutes it toggles
 * a storage-backed shield setting through the extension service worker,
 * exercising the config-update path (bridge -> CE events -> engine).
 *
 * A retained-memory slope near zero with stable Nodes / JSEventListeners
 * counts means no leak; growth in any of the three is investigated.
 *
 * Requirements: CHROME_BIN pointing at Chromium or Chrome for Testing
 * (branded Google Chrome 137+ ignores --load-extension — see perf_bench.js).
 *
 * Usage:
 *   CHROME_BIN=/path/to/chrome node tests/soak_verify.js [minutes]   # default 30
 */

const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const path = require('path');

const EXT_PATH = path.resolve(__dirname, '..');

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function httpGetJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { resolve(d); } });
    }).on('error', reject);
  });
}

class CDP {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl);
    this.id = 1;
    this.cb = new Map();
    this.ready = new Promise((res, rej) => { this.ws.onopen = res; this.ws.onerror = rej; });
    this.ws.onmessage = e => {
      const m = JSON.parse(e.data);
      if (m.id && this.cb.has(m.id)) {
        const { resolve, reject } = this.cb.get(m.id);
        this.cb.delete(m.id);
        m.error ? reject(m.error) : resolve(m.result);
      }
    };
  }
  send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = this.id++;
      this.cb.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
}

const SOAK_HTML = `<!DOCTYPE html><html><head><meta charset="utf-8"></head>
<body><div id="host" style="font-family:sans-serif">soak</div>
<script>
window.__soakCycle = async () => {
  // Canvas export path (farbling + export restore bookkeeping)
  const c = document.createElement('canvas');
  c.width = 300; c.height = 150;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#123456'; ctx.fillRect(0, 0, 300, 150); ctx.fillText('soak', 5, 20);
  ctx.getImageData(0, 0, 1, 1);
  c.toDataURL();
  // Audio first-read mutation path
  if (!window.__actx) { try { window.__actx = new AudioContext(); } catch (e) {} }
  if (window.__actx) { const b = window.__actx.createBuffer(1, 5000, 44100); b.getChannelData(0); }
  // Layout fast path + masking path
  const host = document.getElementById('host');
  for (let i = 0; i < 50; i++) host.getBoundingClientRect();
  const s = document.createElement('span');
  s.style.fontFamily = "'SimSun', sans-serif";
  s.textContent = 'soak';
  host.appendChild(s);
  s.getBoundingClientRect();
  s.remove();
  // Worker wrap/unwrap churn
  await new Promise((resolve) => {
    let done = false;
    const finish = () => { if (!done) { done = true; resolve(); } };
    try {
      const w = new Worker(URL.createObjectURL(new Blob(['self.onmessage=()=>postMessage(1)'])));
      w.onmessage = () => { w.terminate(); finish(); };
      w.onerror = () => finish();
      w.postMessage(1);
      setTimeout(finish, 2000);
    } catch (e) { finish(); }
  });
  // Same-origin iframe churn (per-frame realm creation / adoption path)
  await new Promise((resolve) => {
    const f = document.createElement('iframe');
    f.src = 'about:blank';
    document.body.appendChild(f);
    setTimeout(() => { f.remove(); resolve(); }, 30);
  });
  return true;
};
</script></body></html>`;

async function main() {
  const minutes = Number(process.argv[2]) || 30;
  const httpPort = 8895;
  const devtoolsPort = 9895;
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(SOAK_HTML);
  });
  await new Promise(r => server.listen(httpPort, '127.0.0.1', r));

  const chrome = spawn(process.env.CHROME_BIN || 'chromium', [
    '--headless=new', '--no-sandbox', '--disable-gpu',
    `--user-data-dir=${fs.mkdtempSync('/tmp/soak-')}`,
    `--remote-debugging-port=${devtoolsPort}`,
    `--load-extension=${EXT_PATH}`,
    `--disable-extensions-except=${EXT_PATH}`,
    'about:blank'
  ], { stdio: 'ignore' });

  try {
    let targets = null;
    for (let i = 0; i < 40; i++) {
      try {
        targets = await httpGetJson(`http://127.0.0.1:${devtoolsPort}/json/list`);
        if (Array.isArray(targets) && targets.length) break;
      } catch (_) {}
      await sleep(300);
    }
    if (!targets || !targets.length) throw new Error('Chrome did not expose a CDP endpoint; check CHROME_BIN');
    const page = targets.find(t => t.type === 'page');
    const cdp = new CDP(page.webSocketDebuggerUrl);
    await cdp.ready;
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Performance.enable');

    await cdp.send('Page.navigate', { url: `http://127.0.0.1:${httpPort}/a` });
    await sleep(2500);
    await cdp.send('Page.navigate', { url: `http://127.0.0.1:${httpPort}/b` });
    await sleep(2500);

    const engineOn = (await cdp.send('Runtime.evaluate', {
      expression: `typeof window[Symbol.for('__bpc_pm_7e4b1c92')]`,
      returnByValue: true
    })).result.value === 'object';
    if (!engineOn) {
      console.error('WARNING: extension engine did not apply — soak would measure a bare browser. Aborting.');
      process.exit(1);
    }

    // Attach to the extension service worker for periodic config toggles.
    let swCdp = null;
    try {
      const t2 = await httpGetJson(`http://127.0.0.1:${devtoolsPort}/json/list`);
      const sw = (t2 || []).find(t => t.type === 'service_worker' && /background\/service_worker\.js$/.test(t.url || ''));
      if (sw) {
        swCdp = new CDP(sw.webSocketDebuggerUrl);
        await swCdp.ready;
        await swCdp.send('Runtime.enable');
        console.log('Attached to extension service worker for config toggles.');
      } else {
        console.log('NOTE: extension service worker target not found; config-toggle part of the soak is skipped.');
      }
    } catch (e) {
      console.log('NOTE: service worker attach failed (' + e.message + '); config-toggle part skipped.');
    }

    const ev = async (expr) => (await cdp.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })).result.value;

    const sample = async () => {
      try { await cdp.send('HeapProfiler.collectGarbage'); } catch (_) {}
      const m = await cdp.send('Performance.getMetrics');
      const g = n => { const x = m.metrics.find(y => y.name === n); return x ? x.value : -1; };
      return {
        t: Date.now(),
        heapMB: Math.round(g('JSHeapUsedSize') / 1048576 * 100) / 100,
        nodes: g('Nodes'),
        listeners: g('JSEventListeners'),
        docs: g('Documents')
      };
    };

    const start = Date.now();
    const endAt = start + minutes * 60 * 1000;
    let nextSample = start + 60000;
    let nextToggle = start + 300000;
    let toggleState = false;
    let cycles = 0;
    const samples = [];

    while (Date.now() < endAt) {
      try {
        await ev('window.__soakCycle()');
        cycles++;
      } catch (e) {
        console.error('cycle error:', e.message);
      }
      if (Date.now() >= nextSample) {
        const s = await sample();
        samples.push(s);
        const elapsedMin = ((s.t - start) / 60000).toFixed(1);
        console.log(`[${elapsedMin}min] heap=${s.heapMB}MB nodes=${s.nodes} listeners=${s.listeners} docs=${s.docs} cycles=${cycles}`);
        nextSample += 60000;
      }
      if (swCdp && Date.now() >= nextToggle) {
        toggleState = !toggleState;
        try {
          await swCdp.send('Runtime.evaluate', {
            expression: `chrome.storage.local.set({ canvasProtection: ${toggleState} })`,
            returnByValue: true
          });
        } catch (e) {
          console.error('config toggle error:', e.message);
        }
        nextToggle += 300000;
      }
      await sleep(1000);
    }

    // Analysis: skip the first 4 samples (warmup), fit the retained-heap slope.
    const warm = samples.slice(4);
    console.log('\n=== SOAK SUMMARY ===');
    console.log(`cycles: ${cycles}, samples: ${samples.length}`);
    if (warm.length >= 3) {
      const first = warm[0];
      const last = warm[warm.length - 1];
      const hours = (last.t - first.t) / 3600000;
      const slope = hours > 0 ? (last.heapMB - first.heapMB) / hours : 0;
      console.log(`retained heap: ${first.heapMB}MB -> ${last.heapMB}MB over ${(hours * 60).toFixed(1)}min  (${slope.toFixed(1)} MB/h slope, warmup excluded)`);
      console.log(`nodes: ${first.nodes} -> ${last.nodes}  listeners: ${first.listeners} -> ${last.listeners}  docs: ${first.docs} -> ${last.docs}`);
      const leaky = slope > 30 || (last.nodes > first.nodes * 1.5 + 50) || (last.listeners > first.listeners * 1.5 + 20);
      console.log(leaky ? 'VERDICT: growth exceeds baseline noise — investigate the trend.' : 'VERDICT: no significant retained growth (heap slope, nodes and listeners all stable).');
    } else {
      console.log('Not enough samples for slope analysis.');
    }
  } finally {
    chrome.kill('SIGKILL');
    server.close();
  }
}

main().catch(err => {
  console.error('Fatal error in soak_verify:', err.message || err);
  process.exit(1);
});
