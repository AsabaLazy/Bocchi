#!/usr/bin/env node
'use strict';

/**
 * tests/perf_bench.js — Reproducible performance baseline for the extension.
 *
 * Compares a headless Chrome (with the extension loaded) against the same
 * Chrome without the extension, running an identical workload and reporting
 * per-operation deltas. Use it as a regression gate: run `both` before and
 * after changes and compare.
 *
 * Requirements:
 *   - CHROME_BIN pointing at a Chromium or Chrome for Testing build.
 *     NOTE: branded Google Chrome 137+ silently ignores --load-extension;
 *     install Chrome for Testing with:
 *       npx @puppeteer/browsers install chrome@stable --path /tmp/cft
 *     then: CHROME_BIN=/tmp/cft/chrome/&lt;version&gt;/chrome-linux64/chrome node tests/perf_bench.js both
 *
 * Usage:
 *   node tests/perf_bench.js both    # run noext + ext and print deltas (default)
 *   node tests/perf_bench.js ext     # extension only
 *   node tests/perf_bench.js noext   # baseline only
 *
 * Measured: engine init (navigation timing), steady-state hot paths (layout
 * reads, canvas readbacks, performance.now, navigator), protection paths
 * (font probes, toDataURL, audio, workers), a JSON control (unhooked path),
 * and per-page JS heap. Numbers are environment-specific; deltas are the
 * meaningful output.
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

async function runMode(mode, basePort) {
  const httpPort = basePort;
  const devtoolsPort = basePort + 1000;
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(BENCH_HTML);
  });
  await new Promise(r => server.listen(httpPort, '127.0.0.1', r));

  const args = ['--headless=new', '--no-sandbox', '--disable-gpu', `--user-data-dir=${fs.mkdtempSync('/tmp/perf-')}`, `--remote-debugging-port=${devtoolsPort}`, 'about:blank'];
  if (mode === 'ext') {
    args.push(`--load-extension=${EXT_PATH}`, `--disable-extensions-except=${EXT_PATH}`);
  }
  const chrome = spawn(process.env.CHROME_BIN || 'chromium', args, { stdio: 'ignore' });

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

    // Two navigations: the second (warm) one is measured.
    await cdp.send('Page.navigate', { url: `http://127.0.0.1:${httpPort}/a` });
    await sleep(2500);
    await cdp.send('Page.navigate', { url: `http://127.0.0.1:${httpPort}/b` });
    await sleep(2500);

    const ev = async (expr) => (await cdp.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })).result.value;

    const sanity = await ev(`(() => ({ engineMarks: typeof window[Symbol.for('__bpc_pm_7e4b1c92')] }))()`);
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

    if (mode === 'ext' && sanity.engineMarks !== 'object') {
      console.error('WARNING: extension engine did not apply (engineMarks !== object). Extension loading may have failed — check that CHROME_BIN is Chromium/Chrome for Testing, not branded Chrome.');
    }
    return { nav, bench, worker20: Math.round(workerMs), heapMB, engineApplied: mode === 'ext' ? sanity.engineMarks === 'object' : null };
  } finally {
    chrome.kill('SIGKILL');
    server.close();
  }
}

function printDelta(base, ext) {
  const rows = [];
  const push = (label, a, b) => rows.push(`${label.padEnd(28)} ${String(a).padStart(10)} → ${String(b).padStart(10)}  (${b - a >= 0 ? '+' : ''}${(Math.round((b - a) * 100) / 100)})`);
  push('nav.domContentLoaded (ms)', base.nav.domContentLoaded, ext.nav.domContentLoaded);
  push('nav.load (ms)', base.nav.load, ext.nav.load);
  push('nav.firstScriptStart (ms)', base.nav.firstScriptStart, ext.nav.firstScriptStart);
  for (const k of Object.keys(base.bench)) {
    push(k, Math.round(base.bench[k] * 10) / 10, Math.round(ext.bench[k] * 10) / 10);
  }
  push('worker20 (ms)', base.worker20, ext.worker20);
  push('heapMB', base.heapMB, ext.heapMB);
  console.log('\n=== noext → ext deltas ===');
  console.log(rows.join('\n'));
}

async function main() {
  const mode = process.argv[2] || 'both';
  if (mode === 'noext') {
    console.log(JSON.stringify(await runMode('noext', 8877), null, 2));
    return;
  }
  if (mode === 'ext') {
    console.log(JSON.stringify(await runMode('ext', 8878), null, 2));
    return;
  }
  const base = await runMode('noext', 8879);
  const ext = await runMode('ext', 8891);
  console.log('=== noext ===');
  console.log(JSON.stringify(base, null, 2));
  console.log('=== ext ===');
  console.log(JSON.stringify(ext, null, 2));
  printDelta(base, ext);
}

main().catch(err => {
  console.error('Fatal error in perf_bench:', err.message || err);
  process.exit(1);
});
