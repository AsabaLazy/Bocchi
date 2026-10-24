#!/usr/bin/env node
'use strict';

/**
 * tests/perf_bench.js — Reproducible performance baseline for the extension.
 *
 * Launches Chromium with the repo-root extension loaded through the shared
 * live harness (tests/lib/live_harness.js), navigates twice to a locally
 * served bench page (the second, warm navigation is the measured one) and
 * records per-operation timings of the engine's hooked hot paths. Use it as
 * a regression gate: run before and after changes and compare the saved
 * reports in tests/reports/. The gate fails (exit 1) when a metric is
 * malformed or exceeds its threshold.
 *
 * Timing: the extension's hardwareTimer clamp is disabled in extension
 * storage BEFORE the bench page is loaded, and the page proves
 * performance.now() still yields fractional samples. Otherwise every
 * measurement would be quantised to whole milliseconds by the engine hook.
 * Override thresholds with BENCH_MAX_<METRIC> (e.g. BENCH_MAX_FONTPROBE_300).
 *
 * Requirements:
 *   - CHROME_BIN pointing at a Chromium or Chrome for Testing build.
 *     NOTE: branded Google Chrome 137+ silently ignores --load-extension;
 *     install Chrome for Testing with:
 *       npx @puppeteer/browsers install chrome@156.0.8078.47 --path /tmp/cft
 *     then: CHROME_BIN=/tmp/cft/chrome/<version>/chrome-linux64/chrome node tests/perf_bench.js
 *
 * Usage:
 *   node tests/perf_bench.js             # headless run (default)
 *   HEADED=1 node tests/perf_bench.js    # real window, real GPU rendering
 *
 * The pre-harness version also ran a no-extension baseline ("noext"/"both"
 * modes) and printed noext→ext deltas. The shared harness always launches
 * with the extension loaded, so this script measures the extension side
 * only; compare successive saved reports to detect regressions.
 *
 * Measured: engine init (navigation timing), steady-state hot paths (layout
 * reads, canvas readbacks, performance.now, navigator), protection paths
 * (font probes, toDataURL, audio, workers), a JSON control (unhooked path),
 * and per-page JS heap. Numbers are environment-specific; trends across
 * runs are the meaningful output.
 */

const http = require('http');

const h = require('./lib/live_harness');

// ---------------------------------------------------------------------------
// Gate configuration
//
// Timings are environment-specific, so the default limits are absolution
// ceilings chosen at ~10-40x the recorded baseline for each batch (roughly
// 0.2-20 ms per operation at the high end). They are deliberately strict
// enough to catch an accidental per-call reflow/hook recursion, while still
// tolerating slow CI hardware. Override any key with BENCH_MAX_<KEY>
// (upper-case), e.g. BENCH_MAX_LAYOUTREADS_20000=200.
// ---------------------------------------------------------------------------
const DEFAULT_LIMITS = {
  navLoad: 5000,
  layoutReads_20000: 400,
  fontProbe_300: 500,
  canvasGetImageData_2000: 400,
  canvasToDataURL_100: 500,
  audioBuffers_200: 400,
  audioReuse_2000: 400,
  perfNow_200000: 400,
  navigatorReads_50000: 400,
  jsonRoundtrip_20000: 400,
  worker20: 2000,
  heapMB: 256
};

const BENCH_KEYS = [
  'layoutReads_20000',
  'fontProbe_300',
  'canvasGetImageData_2000',
  'canvasToDataURL_100',
  'audioBuffers_200',
  'audioReuse_2000',
  'perfNow_200000',
  'navigatorReads_50000',
  'jsonRoundtrip_20000'
];

function readLimits() {
  const limits = {};
  for (const [key, fallback] of Object.entries(DEFAULT_LIMITS)) {
    const raw = process.env[`BENCH_MAX_${key.toUpperCase()}`];
    if (raw === undefined || raw === '') {
      limits[key] = fallback;
      continue;
    }
    const value = Number(raw);
    if (!Number.isFinite(value) || value <= 0) {
      throw new Error(`Invalid BENCH_MAX_${key.toUpperCase()}=${JSON.stringify(raw)} (expected a positive number)`);
    }
    limits[key] = value;
  }
  return limits;
}

// Minimal service-worker CDP client. The harness binds `cdp` to the page
// target, so disabling the extension's timer clamp before navigation needs an
// independent connection to the background service worker.
class SwCdp {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl);
    this.id = 1;
    this.cb = new Map();
    this.ready = new Promise((resolve, reject) => {
      this.ws.onopen = resolve;
      this.ws.onerror = reject;
    });
    this.ws.onmessage = (event) => {
      const message = JSON.parse(event.data);
      if (message.id && this.cb.has(message.id)) {
        const { resolve, reject } = this.cb.get(message.id);
        this.cb.delete(message.id);
        message.error ? reject(message.error) : resolve(message.result);
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

async function waitForServiceWorker(port, timeoutMs = 15000) {
  const start = Date.now();
  let lastError = null;
  while (Date.now() - start < timeoutMs) {
    try {
      const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      const sw = (targets || []).find(t =>
        t.type === 'service_worker' && /background\/service_worker\.js$/.test(t.url || ''));
      if (sw && sw.webSocketDebuggerUrl) return sw;
    } catch (err) {
      lastError = err;
    }
    await h.sleep(250);
  }
  throw new Error(`Extension service worker target not found within ${timeoutMs}ms` +
    (lastError ? `: ${lastError.message}` : ''));
}

/**
 * Disable the extension's timer-precision clamp in extension storage BEFORE
 * the benchmark page is loaded. Otherwise performance.now() is floored to
 * whole milliseconds by the engine and every measurement is quantised.
 */
async function disableTimerClamp(port) {
  const sw = await waitForServiceWorker(port);
  const client = new SwCdp(sw.webSocketDebuggerUrl);
  await client.ready;
  try {
    await client.send('Runtime.enable');
    await client.send('Runtime.evaluate', {
      expression: 'new Promise(resolve => chrome.storage.local.set({ hardwareTimer: false }, () => resolve(true)))',
      awaitPromise: true,
      returnByValue: true
    });
    const res = await client.send('Runtime.evaluate', {
      expression: "new Promise(resolve => chrome.storage.local.get(['hardwareTimer'], resolve))",
      awaitPromise: true,
      returnByValue: true
    });
    const stored = res && res.result && res.result.value;
    if (!stored || stored.hardwareTimer !== false) {
      throw new Error(`Failed to disable hardwareTimer in extension storage: ${JSON.stringify(stored)}`);
    }
  } finally {
    client.close();
  }
}

function validateBenchResult(result, limits) {
  const errors = [];
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    return ['window.__bench() did not return an object'];
  }
  const bench = result.bench;
  if (!bench || typeof bench !== 'object' || Array.isArray(bench)) {
    return ['window.__bench() result has no bench object'];
  }
  for (const key of BENCH_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(bench, key)) {
      errors.push(`missing metric ${key}`);
      continue;
    }
    const value = bench[key];
    if (!Number.isFinite(value)) {
      errors.push(`metric ${key} is not a finite number (${JSON.stringify(value)})`);
      continue;
    }
    if (value < 0) {
      errors.push(`metric ${key} was not measured (sentinel ${value})`);
      continue;
    }
    if (value === 0) {
      errors.push(`metric ${key} is zero (measurement did not run)`);
      continue;
    }
    if (value > limits[key]) {
      errors.push(`metric ${key}=${value}ms exceeds limit ${limits[key]}ms (BENCH_MAX_${key.toUpperCase()})`);
    }
  }
  for (const key of ['domContentLoaded', 'load', 'firstScriptStart']) {
    const value = result.nav && result.nav[key];
    if (!Number.isFinite(value) || value <= 0) {
      errors.push(`nav.${key} must be a finite positive number (${JSON.stringify(value)})`);
    }
  }
  if (!Number.isFinite(result.worker20) || result.worker20 < 0) {
    errors.push(`worker20 is not a finite non-negative number (${JSON.stringify(result.worker20)})`);
  } else if (result.worker20 > limits.worker20) {
    errors.push(`worker20=${result.worker20}ms exceeds limit ${limits.worker20}ms (BENCH_MAX_WORKER20)`);
  }
  // -1 / null / 0 means the metric was never collected; treat that as a
  // failure instead of a valid measurement.
  if (!Number.isFinite(result.heapBytes) || result.heapBytes <= 0) {
    errors.push(`JSHeapUsedSize must be a finite positive number (${JSON.stringify(result.heapBytes)})`);
  }
  if (!Number.isFinite(result.heapMB) || result.heapMB <= 0) {
    errors.push(`heapMB must be a finite positive number (${JSON.stringify(result.heapMB)})`);
  } else if (result.heapMB > limits.heapMB) {
    errors.push(`heapMB=${result.heapMB} exceeds limit ${limits.heapMB}MB (BENCH_MAX_HEAPMB)`);
  }
  if (result.nav && Number.isFinite(result.nav.load) && result.nav.load > limits.navLoad) {
    errors.push(`nav.load=${result.nav.load}ms exceeds limit ${limits.navLoad}ms (BENCH_MAX_NAVLOAD)`);
  }
  if (!result.timing || !Number.isFinite(result.timing.fractionalSamples) ||
      !Number.isFinite(result.timing.totalSamples) || result.timing.totalSamples <= 0) {
    errors.push(`timing probe missing or malformed (${JSON.stringify(result.timing)})`);
  } else if (result.timing.fractionalSamples === 0) {
    errors.push('performance.now() returned only integers after disabling hardwareTimer; timing is still clamped');
  }
  return errors;
}

const BENCH_HTML = `<!DOCTYPE html><html><head><meta charset="utf-8"><script>window.__t0 = performance.now();</script></head>
<body><div id="host" style="font-family:sans-serif">bench</div>
<canvas id="c" width="300" height="150"></canvas>
<script>
window.__bench = () => {
  const out = {};
  const timeIt = (fn, n) => { const t0 = performance.now(); for (let i = 0; i < n; i++) fn(i); return performance.now() - t0; };
  const c = document.getElementById('c'); const ctx = c.getContext('2d');
  ctx.fillStyle = '#abc'; ctx.fillRect(0, 0, 300, 150); ctx.fillText('hello', 10, 20);
  timeIt(() => document.body.getBoundingClientRect(), 500); // warmup

  out.layoutReads_20000 = timeIt(() => document.body.getBoundingClientRect(), 20000);
  out.fontProbe_300 = timeIt((i) => {
    const s = document.createElement('span');
    s.style.fontFamily = "'SimSun', 'Microsoft YaHei', sans-serif";
    s.textContent = 'font-probe-' + i;
    document.getElementById('host').appendChild(s);
    s.getBoundingClientRect();
    s.remove();
  }, 300);
  out.canvasGetImageData_2000 = timeIt(() => ctx.getImageData(0, 0, 1, 1), 2000);
  out.canvasToDataURL_100 = timeIt(() => c.toDataURL(), 100);
  let audioCtx = null;
  try { audioCtx = new AudioContext(); } catch (e) {}
  out.audioBuffers_200 = audioCtx ? timeIt(() => {
    const b = audioCtx.createBuffer(1, 5000, 44100);
    b.getChannelData(0);
  }, 200) : -1;
  out.audioReuse_2000 = audioCtx ? (() => {
    const b = audioCtx.createBuffer(1, 5000, 44100);
    b.getChannelData(0);
    return timeIt(() => b.getChannelData(0), 2000);
  })() : -1;
  out.perfNow_200000 = timeIt(() => performance.now(), 200000);
  out.navigatorReads_50000 = timeIt(() => navigator.userAgent, 50000);
  const doc = JSON.stringify({ a: 'x'.repeat(1000), b: [1, 2, 3], c: { d: 1 } });
  out.jsonRoundtrip_20000 = timeIt(() => JSON.parse(doc), 20000);
  return out;
};
window.__workerBench = async (n) => {
  const t0 = performance.now();
  const jobs = [];
  for (let i = 0; i < n; i++) {
    jobs.push(new Promise((resolve, reject) => {
      const w = new Worker(URL.createObjectURL(new Blob(['self.onmessage=e=>postMessage(e.data+1)'])));
      w.onmessage = () => { w.terminate(); resolve(); };
      w.onerror = (e) => reject(new Error(e.message));
      w.postMessage(41);
    }));
  }
  await Promise.all(jobs);
  return performance.now() - t0;
};
</script></body></html>`;

async function main() {
  // Local workload server: serves the identical bench page for both
  // navigations (the second, warm one is measured).
  const httpPort = await h.freePort();
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(BENCH_HTML);
  });
  await new Promise(r => server.listen(httpPort, '127.0.0.1', r));

  try {
    const result = await h.runWithRetry('perf-bench', { headed: process.env.HEADED === '1' }, async (ctx) => {
      const cdp = ctx.cdp;
      console.log(`Running perf bench (${ctx.headed ? 'headed' : 'headless'}, bin=${ctx.bin})`);

      await cdp.send('Page.enable');
      await cdp.send('Runtime.enable');
      await cdp.send('Performance.enable');

      // Disable the engine's performance.now() floor BEFORE loading the page:
      // benchmarks measured through a millisecond-quantised clock are noise.
      await disableTimerClamp(ctx.port);
      console.log('hardwareTimer=false set in extension storage (unclamped timing).');

      // Two navigations: the second (warm) one is measured.
      await cdp.send('Page.navigate', { url: `http://127.0.0.1:${httpPort}/a` });
      await h.sleep(2500);
      await cdp.send('Page.navigate', { url: `http://127.0.0.1:${httpPort}/b` });
      await h.sleep(2500);

      // Bare-browser guard: benchmark numbers from a browser where the
      // extension engine never injected are meaningless. Throws
      // EngineMissingError (runWithRetry retries once with a fresh profile).
      await h.ensureEngine(ctx.cdp);

      const ev = async (expr) => {
        const res = await cdp.send('Runtime.evaluate', {
          expression: expr, returnByValue: true, awaitPromise: true
        });
        if (res && res.exceptionDetails) {
          throw new Error('Runtime.evaluate exception: ' + JSON.stringify(res.exceptionDetails));
        }
        return res && res.result ? res.result.value : undefined;
      };

      // Prove the clamp is actually off in the measured page: a clamped
      // performance.now() returns integers only.
      const timing = await ev(`(() => {
        let fractional = 0;
        const total = 2000;
        for (let i = 0; i < total; i++) {
          if (!Number.isInteger(performance.now())) fractional++;
        }
        return { fractionalSamples: fractional, totalSamples: total };
      })()`);
      console.log(`Timer resolution check: ${timing.fractionalSamples}/${timing.totalSamples} fractional performance.now() samples`);

      // Poll for a complete navigation entry: reading immediately can return
      // loadEventEnd === 0 (load still in flight) and would look like a
      // measurement rather than missing evidence.
      let nav = null;
      await (async () => {
        const deadline = Date.now() + 10000;
        while (Date.now() < deadline) {
          nav = await ev(`(() => {
            const e = performance.getEntriesByType('navigation')[0] || {};
            return {
              domContentLoaded: Math.round(e.domContentLoadedEventEnd - e.startTime),
              load: Math.round(e.loadEventEnd - e.startTime),
              firstScriptStart: Math.round(window.__t0 || -1)
            };
          })()`);
          if (nav && nav.domContentLoaded > 0 && nav.load > 0 && nav.firstScriptStart > 0) break;
          await h.sleep(100);
        }
      })();
      const bench = await ev(`window.__bench()`);
      const workerMs = await ev(`window.__workerBench(20)`);
      const metrics = await cdp.send('Performance.getMetrics');
      const mget = n => { const m = metrics.metrics.find(x => x.name === n); return m ? m.value : null; };
      const heapBytes = mget('JSHeapUsedSize');
      const heapMB = Number.isFinite(heapBytes) ? Math.round(heapBytes / 1048576 * 10) / 10 : null;

      // ensureEngine threw otherwise, so reaching here means the engine applied.
      return {
        bin: ctx.bin,
        headed: ctx.headed,
        nav,
        bench,
        worker20: Math.round(workerMs),
        heapBytes,
        heapMB,
        timing,
        engineApplied: true
      };
    });

    console.log('=== perf-bench (extension loaded) ===');
    console.log(JSON.stringify(result, null, 2));

    const limits = readLimits();
    const errors = validateBenchResult(result, limits);
    if (errors.length) {
      console.error('\nPERF GATE: FAIL');
      for (const error of errors) console.error(`  - ${error}`);
      process.exitCode = 1;
    } else {
      console.log('\nPERF GATE: PASS (all metrics finite and within limits)');
    }

    const report = {
      name: 'perf-bench',
      timestamp: new Date().toISOString(),
      note: 'Extension-loaded run via the shared live harness with hardwareTimer disabled before navigation (unclamped performance.now). Compare reports across runs (e.g. before/after a change).',
      limits,
      passed: errors.length === 0,
      failures: errors,
      result
    };
    const reportPath = h.saveReport('perf-bench', report);
    console.log('Report saved to:', reportPath);
  } finally {
    server.close();
  }
}

main().catch(err => {
  console.error('Fatal error in perf_bench:', err.message || err);
  process.exitCode = 1;
});
