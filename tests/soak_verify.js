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
 *
 * Exit status: non-zero when the trend is leaky, when fewer than 5 samples
 * (3 post-warmup samples) were collected, when cycles fail en masse, when a
 * required metric is missing/sentinel (heap, nodes, listeners, documents),
 * when the extension service worker cannot be attached, when a config toggle
 * cannot be observed in the page, or when the extension engine is no longer
 * applied at the end of the run.
 */

const http = require('http');
const h = require('./lib/live_harness');

// Gate thresholds. A soak that cannot produce enough evidence is a failure,
// not a pass: otherwise a broken browser/extension yields a green exit.
const MIN_SAMPLES = 5;              // >= 5 one-minute samples
const MIN_WARM_SAMPLES = 3;         // analysis skips the first 4 (warmup)
const MAX_CYCLE_FAILURE_RATE = 0.05;
const MIN_FAILED_CYCLES = 3;        // tolerate a couple of transient blips

const SOAK_HTML = `<!DOCTYPE html><html><head><meta charset="utf-8"></head>
<body><div id="host" style="font-family:sans-serif">soak</div>
<script>
// Keep JSEventListeners meaningfully non-zero for the gate.
window.addEventListener('resize', () => {});
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
 * Poll /json/list for the extension service worker and attach to it. The
 * target can appear after the first listing (and a restarted SW may take a
 * moment to re-register), so a one-shot sample is not evidence.
 */
async function attachServiceWorker(port, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      const sw = (targets || []).find(t =>
        t.type === 'service_worker' && /background\/service_worker\.js$/.test(t.url || ''));
      if (sw && sw.webSocketDebuggerUrl) {
        const client = new SwCdp(sw.webSocketDebuggerUrl);
        try {
          await client.ready;
          await client.send('Runtime.enable');
          return client;
        } catch (err) {
          try { client.close(); } catch (_) {}
          lastError = err;
        }
      }
    } catch (err) {
      lastError = err;
    }
    await h.sleep(250);
  }
  throw new Error(`extension service worker target not found within ${timeoutMs}ms` +
    (lastError ? `: ${lastError.message}` : ''));
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

  // Attach to the extension service worker for periodic config toggles. The
  // SW target can appear after launch, so poll for it. A missing/broken SW is
  // a gate failure, not a silent skip: the config-update path is part of the
  // workload this soak claims to exercise.
  let swCdp = null;
  let swAttachError = null;
  try {
    swCdp = await attachServiceWorker(ctx.port);
    console.log('Attached to extension service worker for config toggles.');
  } catch (e) {
    swAttachError = e.message;
    console.error('service worker attach error:', e.message);
  }

  const ev = async (expr) => {
    const res = await cdp.send('Runtime.evaluate', {
      expression: expr, returnByValue: true, awaitPromise: true
    });
    if (res && res.exceptionDetails) {
      throw new Error('Runtime.evaluate exception: ' + JSON.stringify(res.exceptionDetails));
    }
    return res && res.result ? res.result.value : undefined;
  };

  const swEval = async (expr) => {
    if (!swCdp) throw new Error('service worker is not attached');
    const res = await swCdp.send('Runtime.evaluate', {
      expression: expr, returnByValue: true, awaitPromise: true
    });
    if (res && res.exceptionDetails) {
      throw new Error('service worker Runtime.evaluate exception: ' + JSON.stringify(res.exceptionDetails));
    }
    return res && res.result ? res.result.value : undefined;
  };

  const sample = async () => {
    try { await cdp.send('HeapProfiler.collectGarbage'); } catch (_) {}
    const m = await cdp.send('Performance.getMetrics');
    const need = (name) => {
      const entry = (m.metrics || []).find(y => y.name === name);
      const value = entry ? entry.value : NaN;
      if (!Number.isFinite(value) || value <= 0) {
        throw new Error(`metric ${name} missing or invalid ` +
          `(${entry ? JSON.stringify(entry.value) : 'absent'})`);
      }
      return value;
    };
    // Reject missing sentinels (-1) and zero: a sample without real
    // heap/node/listener/document counts is not evidence of stability.
    const heapBytes = need('JSHeapUsedSize');
    return {
      t: Date.now(),
      heapMB: Math.round(heapBytes / 1048576 * 100) / 100,
      nodes: need('Nodes'),
      listeners: need('JSEventListeners'),
      docs: need('Documents')
    };
  };

  // The config toggle is only useful if the engine observes it. A 1x1 black
  // canvas exposes canvasProtection directly: off => native channel 0 is 0;
  // on => the farbling step makes it non-zero.
  const canvasPixel = () => ev(`(() => {
    const c = document.createElement('canvas');
    c.width = 1; c.height = 1;
    const g = c.getContext('2d');
    g.fillStyle = '#000'; g.fillRect(0, 0, 1, 1);
    return g.getImageData(0, 0, 1, 1).data[0];
  })()`);

  const waitUntil = async (predicate, label, timeoutMs = 8000) => {
    const deadline = Date.now() + timeoutMs;
    let last = null;
    while (Date.now() < deadline) {
      try {
        last = await predicate();
        if (last) return;
      } catch (err) {
        last = err.message;
      }
      await h.sleep(250);
    }
    throw new Error(`timed out waiting for ${label} (last=${JSON.stringify(last)})`);
  };

  const setCanvasProtection = async (enabled) => {
    const stored = await swEval(
      `new Promise(resolve => chrome.storage.local.set({ canvasProtection: ${enabled} }, ` +
      `() => chrome.storage.local.get(['canvasProtection'], resolve)))`
    );
    if (!stored || stored.canvasProtection !== enabled) {
      throw new Error(`storage readback mismatch for canvasProtection=${enabled}: ${JSON.stringify(stored)}`);
    }
    await waitUntil(async () => {
      const pixel = await canvasPixel();
      return enabled ? pixel > 0 : pixel === 0;
    }, `page-observable canvasProtection=${enabled}`);
  };

  let summary;
  try {
    const start = Date.now();
    const endAt = start + minutes * 60 * 1000;
    let nextSample = start + 60000;
    let nextToggle = start + 300000;
    let canvasProtectionState = true;
    let cycles = 0;
    let failedCycles = 0;
    let toggleFailures = 0;
    const samples = [];
    const failures = [];

    while (Date.now() < endAt) {
      try {
        const cycleResult = await ev('window.__soakCycle()');
        // An expression that throws or returns undefined must not count as a
        // successful workload cycle.
        if (cycleResult !== true) {
          throw new Error(`__soakCycle() returned ${JSON.stringify(cycleResult)} instead of true`);
        }
        cycles++;
      } catch (e) {
        failedCycles++;
        console.error('cycle error:', e.message);
      }
      if (Date.now() >= nextSample) {
        try {
          const s = await sample();
          samples.push(s);
          const elapsedMin = ((s.t - start) / 60000).toFixed(1);
          console.log(`[${elapsedMin}min] heap=${s.heapMB}MB nodes=${s.nodes} listeners=${s.listeners} docs=${s.docs} cycles=${cycles}`);
        } catch (e) {
          // A missing metric means there is no memory evidence to analyze;
          // record it and stop rather than continuing with sentinel values.
          console.error('metric sample error:', e.message);
          failures.push(`metric sample failed: ${e.message}`);
          break;
        }
        nextSample += 60000;
      }
      if (swCdp && Date.now() >= nextToggle) {
        canvasProtectionState = !canvasProtectionState;
        try {
          await setCanvasProtection(canvasProtectionState);
          console.log(`config toggle: canvasProtection=${canvasProtectionState} observed in page`);
        } catch (e) {
          toggleFailures++;
          console.error('config toggle error:', e.message);
        }
        nextToggle += 300000;
      }
      await h.sleep(1000);
    }

    if (swAttachError) {
      failures.push(`service worker attach failed: ${swAttachError}`);
    }
    if (toggleFailures > 0) {
      failures.push(`config toggle failed ${toggleFailures} time(s)`);
    }

    // Final engine check: if the extension dropped out mid-soak, the memory
    // numbers are meaningless (the workload ran in a bare browser).
    const finalEngine = await h.engineSanity(cdp).catch(err => ({
      ok: false,
      detail: { error: err && err.message ? err.message : String(err) }
    }));
    console.log('ENGINE SANITY (end):', JSON.stringify(finalEngine.detail));

    // Analysis: skip the first 4 samples (warmup), fit the retained-heap slope.
    const warm = samples.slice(4);
    console.log('\n=== SOAK SUMMARY ===');
    const totalCycles = cycles + failedCycles;
    console.log(`cycles: ${cycles} ok / ${totalCycles} attempted (${failedCycles} failed), samples: ${samples.length}`);
    if (samples.length < MIN_SAMPLES || warm.length < MIN_WARM_SAMPLES) {
      failures.push(`insufficient samples: ${samples.length} total / ${warm.length} warm (need >= ${MIN_SAMPLES} total and >= ${MIN_WARM_SAMPLES} warm); run the soak longer`);
    }
    if (totalCycles === 0) {
      failures.push('no soak cycles were attempted');
    } else if (failedCycles > MIN_FAILED_CYCLES && (failedCycles / totalCycles) > MAX_CYCLE_FAILURE_RATE) {
      failures.push(`too many failed cycles: ${failedCycles}/${totalCycles} (${(failedCycles / totalCycles * 100).toFixed(1)}% > ${MAX_CYCLE_FAILURE_RATE * 100}%)`);
    }
    if (!finalEngine.ok) {
      failures.push(`extension engine missing at end of soak: ${JSON.stringify(finalEngine.detail)}`);
    }

    let leaky = null;
    if (warm.length >= 3) {
      const first = warm[0];
      const last = warm[warm.length - 1];
      const hours = (last.t - first.t) / 3600000;
      const slope = hours > 0 ? (last.heapMB - first.heapMB) / hours : 0;
      console.log(`retained heap: ${first.heapMB}MB -> ${last.heapMB}MB over ${(hours * 60).toFixed(1)}min  (${slope.toFixed(1)} MB/h slope, warmup excluded)`);
      console.log(`nodes: ${first.nodes} -> ${last.nodes}  listeners: ${first.listeners} -> ${last.listeners}  docs: ${first.docs} -> ${last.docs}`);
      leaky = slope > 30 || (last.nodes > first.nodes * 1.5 + 50) || (last.listeners > first.listeners * 1.5 + 20);
      console.log(leaky ? 'VERDICT: growth exceeds baseline noise — investigate the trend.' : 'VERDICT: no significant retained growth (heap slope, nodes and listeners all stable).');
      if (leaky) {
        failures.push(`leaky trend: heap ${slope.toFixed(1)} MB/h, nodes ${first.nodes}->${last.nodes}, listeners ${first.listeners}->${last.listeners}`);
      }
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
      summary = { warmSamples: warm.length, leaky: null, verdict: 'not-enough-samples' };
    }
    summary.failedCycles = failedCycles;
    summary.totalCycles = totalCycles;
    summary.cycleFailureRate = totalCycles > 0 ? Math.round(failedCycles / totalCycles * 1000) / 1000 : 1;
    summary.toggleFailures = toggleFailures;
    summary.swAttachError = swAttachError;
    summary.engineAtEnd = finalEngine.detail;
    summary.failures = failures;
    summary.passed = failures.length === 0;

    if (failures.length) {
      console.error('\nSOAK FAILED:');
      for (const failure of failures) console.error(`  - ${failure}`);
    } else {
      console.log('\nSOAK PASSED: no leak detected and all evidence checks satisfied.');
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
      passed: summary.passed,
      failures: summary.failures,
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
    if (!report.passed) {
      console.error(`SOAK GATE: FAIL (${report.failures.length} reason(s), see SOAK FAILED above)`);
      process.exitCode = 1;
    } else {
      console.log('SOAK GATE: PASS');
    }
  } finally {
    server.close();
  }
}

main().catch(err => {
  console.error('Fatal error in soak_verify:', err.message || err);
  process.exitCode = 1;
});
