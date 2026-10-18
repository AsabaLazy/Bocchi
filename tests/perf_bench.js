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
 * reports in tests/reports/.
 *
 * Requirements:
 *   - CHROME_BIN pointing at a Chromium or Chrome for Testing build.
 *     NOTE: branded Google Chrome 137+ silently ignores --load-extension;
 *     install Chrome for Testing with:
 *       npx @puppeteer/browsers install chrome@stable --path /tmp/cft
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

      // Two navigations: the second (warm) one is measured.
      await cdp.send('Page.navigate', { url: `http://127.0.0.1:${httpPort}/a` });
      await h.sleep(2500);
      await cdp.send('Page.navigate', { url: `http://127.0.0.1:${httpPort}/b` });
      await h.sleep(2500);

      // Bare-browser guard: benchmark numbers from a browser where the
      // extension engine never injected are meaningless. Throws
      // EngineMissingError (runWithRetry retries once with a fresh profile).
      await h.ensureEngine(ctx.cdp);

      const ev = async (expr) => (await cdp.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })).result.value;

      const nav = await ev(`(() => {
        const e = performance.getEntriesByType('navigation')[0] || {};
        return {
          domContentLoaded: Math.round(e.domContentLoadedEventEnd - e.startTime),
          load: Math.round(e.loadEventEnd - e.startTime),
          firstScriptStart: Math.round(window.__t0 || -1)
        };
      })()`);
      const bench = await ev(`window.__bench()`);
      const workerMs = await ev(`window.__workerBench(20)`);
      const metrics = await cdp.send('Performance.getMetrics');
      const mget = n => { const m = metrics.metrics.find(x => x.name === n); return m ? m.value : -1; };
      const heapMB = Math.round(mget('JSHeapUsedSize') / 1048576 * 10) / 10;

      // ensureEngine threw otherwise, so reaching here means the engine applied.
      return { bin: ctx.bin, headed: ctx.headed, nav, bench, worker20: Math.round(workerMs), heapMB, engineApplied: true };
    });

    console.log('=== perf-bench (extension loaded) ===');
    console.log(JSON.stringify(result, null, 2));

    const report = {
      name: 'perf-bench',
      timestamp: new Date().toISOString(),
      note: 'Extension-loaded run via the shared live harness. The harness always loads the extension, so the old noext/both delta modes are gone; compare reports across runs (e.g. before/after a change) instead.',
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
  process.exit(1);
});
