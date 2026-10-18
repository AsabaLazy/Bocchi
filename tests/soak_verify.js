#!/usr/bin/env node
'use strict';

/**
 * tests/soak_verify.js — Long-running leak check for the extension.
 *
 * Launches Chromium with the extension loaded through the shared live
 * harness (tests/lib/live_harness.js: launch/retry/cleanup/report), drives a
 * continuous mixed workload (canvas exports, audio buffers, worker
 * spawn/terminate, iframe churn, font/layout probes) and samples RETAINED
 * memory every minute (HeapProfiler.collectGarbage before each sample, so
 * garbage in flight is not mistaken for a leak). Every 5 minutes it toggles
 * a storage-backed shield setting through the extension service worker,
 * exercising the config-update path (bridge -> CE events -> engine).
 *
 * A retained-memory slope near zero with stable Nodes / JSEventListeners
 * counts means no leak; growth in any of the three is investigated.
 *
 * Results are saved to tests/reports/ via h.saveReport('soak', ...).
 *
 * Requirements: CHROME_BIN pointing at Chromium or Chrome for Testing
 * (branded Google Chrome 137+ ignores --load-extension — see perf_bench.js).
 *
 * Usage:
 *   CHROME_BIN=/path/to/chrome node tests/soak_verify.js [minutes]   # default 30
 */

const http = require('http');
const h = require('./lib/live_harness');

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

// The shared harness binds its `cdp` to the page target and does not export
// its CDPClient class, so the config-toggle leg of the soak — which needs an
// independent connection to the extension service worker target — keeps this
// minimal SW-only client (same shape as the harness's internal one; relies on
// the Node >= 22 global WebSocket, like the harness itself).
class SwCdp {
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
  close() { this.ws.close(); }
}

/**
 * Soak body (runs inside h.runWithRetry — fresh profile per attempt). Serves
 * SOAK_HTML from `server` on 127.0.0.1:httpPort (started by main), navigates
 * the harness-launched browser there, then samples retained memory while
 * cycling the workload.
 */
async function runSoak(ctx, httpPort, minutes) {
  const cdp = ctx.cdp;

  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Performance.enable');

  await cdp.send('Page.navigate', { url: `http://127.0.0.1:${httpPort}/a` });
  await h.sleep(2500);
  await cdp.send('Page.navigate', { url: `http://127.0.0.1:${httpPort}/b` });
  await h.sleep(2500);

  // Bare-browser guard: if the extension engine never injected, fail loudly
  // (runWithRetry retries once with a fresh profile) instead of soaking an
  // unprotected page.
  const engine = await h.ensureEngine(cdp);
  console.log('ENGINE SANITY:', JSON.stringify(engine.detail));

  // Attach to the extension service worker for periodic config toggles.
  let swCdp = null;
  try {
    const t2 = await (await fetch(`http://127.0.0.1:${ctx.port}/json/list`)).json();
    const sw = (t2 || []).find(t => t.type === 'service_worker' && /background\/service_worker\.js$/.test(t.url || ''));
    if (sw) {
      swCdp = new SwCdp(sw.webSocketDebuggerUrl);
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

  let summary;
  try {
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
      await h.sleep(1000);
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
      summary = {
        warmSamples: warm.length,
        retainedHeapMB: { first: first.heapMB, last: last.heapMB },
        windowMin: Math.round(hours * 60 * 10) / 10,
        heapSlopeMBPerHour: Math.round(slope * 10) / 10,
        nodes: { first: first.nodes, last: last.nodes },
        listeners: { first: first.listeners, last: last.listeners },
        docs: { first: first.docs, last: last.docs },
        leaky,
        verdict: leaky
          ? 'growth exceeds baseline noise — investigate the trend'
          : 'no significant retained growth (heap slope, nodes and listeners all stable)'
      };
    } else {
      console.log('Not enough samples for slope analysis.');
      summary = { warmSamples: warm.length, verdict: 'not-enough-samples' };
    }

    return {
      name: 'soak',
      timestamp: new Date().toISOString(),
      config: {
        minutes,
        headed: ctx.headed,
        bin: ctx.bin,
        sampleIntervalMs: 60000,
        toggleIntervalMs: 300000
      },
      engine: engine.detail,
      serviceWorkerAttached: !!swCdp,
      cycles,
      samples,
      summary
    };
  } finally {
    try { if (swCdp) swCdp.close(); } catch (_) {}
  }
}

async function main() {
  const minutes = Number(process.argv[2]) || 30;
  const httpPort = await h.freePort();
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(SOAK_HTML);
  });
  await new Promise(r => server.listen(httpPort, '127.0.0.1', r));

  try {
    // runWithRetry: up to 2 attempts, each with a fresh profile; retries when
    // launch fails or the body throws EngineMissingError; auto-cleanup.
    const report = await h.runWithRetry('soak', { headed: process.env.HEADED === '1' },
      (ctx) => runSoak(ctx, httpPort, minutes));

    const reportPath = h.saveReport('soak', report);
    console.log(`Report saved: ${reportPath}`);
  } finally {
    server.close();
  }
}

main().catch(err => {
  console.error('Fatal error in soak_verify:', err.message || err);
  process.exit(1);
});
