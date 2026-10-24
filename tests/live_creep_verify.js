'use strict';

/**
 * tests/live_creep_verify.js — CreepJS real-browser audit + regression gate.
 *
 * Launches Chromium (with the repo-root extension loaded) through the shared
 * live harness (tests/lib/live_harness.js), navigates to CreepJS, scrapes the
 * full audit results, then goes beyond display-only reporting:
 *
 *   1. Exit-code gate (GATE below) — the run FAILS (exit 1) when the audit
 *      result regresses, instead of just printing numbers.
 *   2. Worker-thread cross-context probe — same OffscreenCanvas draws and
 *      WebGL reads inside a page-created Blob worker vs the main thread.
 *   3. Reload stability — reload the page once and re-probe the deterministic
 *      fingerprint vectors (canvas pixel / GPU renderer / audio sampleSum).
 *   4. Full report saved to tests/reports/ via h.saveReport('creep', ...).
 *
 * HEADED=1 runs a real desktop window (real GPU rendering, no headless
 * tells) — the most realistic deployment environment. Headless remains the
 * default for CI-style runs.
 *
 * CommonJS, Node stdlib only.
 */

const h = require('./lib/live_harness');

const CREEP_URL = 'https://abrahamjuliot.github.io/creepjs/';

// Exit-code gate configuration. Known-good baseline with the extension:
// totalLies = 3 (the canvas/webgl/audio farbles are inherently visible to
// CreepJS's lie detection) and audio bins/copy matching = true. A bare
// browser (extension failed to load) fakes a "perfect" totalLies = 0 — that
// case is caught by the engineApplied check, not by the lies budget.
// headlessGrade/stealthGrade are environment-dependent (headless vs headed,
// real GPU) and are reported as info items only, never gated.
const GATE = { maxTotalLies: 3 };

const PURE_RED_FILL = [255, 0, 0, 255];
const WORKER_PROBE_TIMEOUT_MS = 10000; // in-page bail-out for a silent worker

// ---------------------------------------------------------------------------
// Page expressions
// ---------------------------------------------------------------------------

// Status poll while CreepJS computes its fingerprint (verbatim from the
// previous version of this script).
const STATUS_EXPRESSION = `(() => {
            const hasFP = !!window.Fingerprint;
            const container = document.querySelector('#fingerprint-data');
            const hasContent = container && container.children.length > 0;
            const hasClass = container && (document.querySelector('.col-four') || document.querySelector('.fuzzy-ui'));
            
            // Check if still calculating
            const timeElapsed = document.querySelector('.time') ? document.querySelector('.time').innerText : '';
            return {
              hasFP,
              hasContent: !!hasContent,
              timeElapsed,
              readyState: document.readyState
            };
          })()`;

// Completion check: all essential fingerprint sections present (verbatim).
const DONE_EXPRESSION = `(() => {
            if (!window.Fingerprint) return null;
            const fp = window.Fingerprint;
            // Check essential keys
            if (!fp.canvas2d || !fp.canvasWebgl || !fp.offlineAudioContext) return null;
            return true;
          })()`;

// Full CreepJS audit scrape (verbatim from the previous version of this
// script — the DOM/Fingerprint grabbing logic must not drift).
const AUDIT_EXPRESSION = `(() => {
        const fp = window.Fingerprint || {};
        const trashBin = fp.trash?.trashBin || [];
        const capturedErrors = fp.capturedErrors || [];
        const totalLies = (fp.lies && fp.lies.totalLies !== undefined) ? fp.lies.totalLies : (fp.trash?.totalLies || 0);

        // Scan all .bold-fail elements
        const boldFailEls = Array.from(document.querySelectorAll('.bold-fail'));
        const boldFailDetails = boldFailEls.map(el => {
          return {
            text: el.innerText,
            outerHTML: el.outerHTML,
            parentText: el.parentElement ? el.parentElement.innerText.replace(/\\s+/g, ' ').trim() : ''
          };
        });

        // Scan all .lies elements
        const liesEls = Array.from(document.querySelectorAll('.lies'));
        const liesDetails = liesEls.map(el => ({
          text: el.innerText,
          parentText: el.parentElement ? el.parentElement.innerText.replace(/\\s+/g, ' ').trim() : ''
        }));

        // Get Audio details
        const audioInfo = fp.offlineAudioContext ? {
          sampleSum: fp.offlineAudioContext.sampleSum,
          compressorGainReduction: fp.offlineAudioContext.compressorGainReduction,
          matching: fp.offlineAudioContext.binsSample && fp.offlineAudioContext.copySample ? ('' + fp.offlineAudioContext.binsSample === '' + fp.offlineAudioContext.copySample) : null,
          lied: fp.offlineAudioContext.lied,
          noise: fp.offlineAudioContext.noise
        } : null;

        // Get Canvas details
        const canvas2dInfo = fp.canvas2d ? {
          lied: fp.canvas2d.lied
        } : null;

        // Get Headless and Stealth ratings
        const headlessGrade = document.querySelector('.headless-rating')?.innerText || (fp.resistance?.headless) || '';
        const stealthGrade = document.querySelector('.stealth-rating')?.innerText || (fp.resistance?.stealth) || '';

        return {
          trashBin,
          capturedErrors,
          totalLies,
          boldFailCount: boldFailEls.length,
          boldFailDetails,
          liesCount: liesEls.length,
          liesDetails,
          audioInfo,
          canvas2dInfo,
          headlessGrade,
          stealthGrade,
          workerScope: fp.workerScope,
          webrtc: fp.webrtc,
          canvasWebgl: fp.canvasWebgl,
          fonts: fp.fonts,
          screen: fp.screen,
          resistance: fp.resistance
        };
      })()`;

// Worker-thread probe semantics — READ FROM ENGINE SOURCE, not guessed
// (content/stealth_engine.js):
//
//  * The engine hooks the page's Worker constructor: `new Worker(url)` runs
//    `generateWorkerBootstrap() + importScripts(url)` inside the worker
//    (section 10, stealth_engine.js:3752-4385; wrapWorkerScript :4401-4490).
//    A page-created Blob worker therefore executes with the bootstrap hooks
//    installed — which is exactly what this probe exercises.
//  * The bootstrap hooks: Function.prototype.toString disguise, worker
//    navigator, performance.memory.jsHeapSizeLimit (:3858-3870), Intl/Date
//    timezone, fonts.check, OffscreenCanvas 2D canvas/font hooks,
//    OffscreenCanvas **WebGL** getParameter (:4303-4331) and WebGPU
//    (:4333-4383). Worker-side 2D reads are therefore farbled exactly like
//    main-thread reads.
//  * Worker OffscreenCanvas WebGL getParameter(37446
//    UNMASKED_RENDERER_WEBGL) returns the SAME pooled gpuProfile.renderer
//    the main thread reports — the profile is interpolated into the
//    bootstrap from the same applyStealth scope (comment :4313-4319: "a
//    worker reporting a different renderer than its page is a cross-context
//    contradiction"). 37445 (UNMASKED_VENDOR_WEBGL) and 0x8B4D
//    (MAX_COMBINED_TEXTURE_IMAGE_UNITS, pinned to 16) also match the
//    main-thread hook (:1310-1315, :1339-1341).
//  * Main-thread OffscreenCanvas 2D IS farbled:
//    OffscreenCanvasRenderingContext2D.prototype.getImageData goes through
//    the shared hookContext2DPrototype (:1147-1150, hook body :826-837):
//    only the R channel of the first read pixel is perturbed
//    (deterministic perturbPixel :579-585 — for an input of 255 the output
//    is 255-step, step in [1,25], so never 255), alpha untouched when
//    already opaque. A pure rgb(255,0,0) fill therefore reads back as
//    [R!=255, 0, 0, 255] on both the main thread and in the worker.
//
// Chosen assertion semantics: 2D farbling is applied in both realms.
//    - workerGpu === mainGpu (plus vendor and 0x8B4D)  -> asserted, gated
//    - main pixel deviates from the pure red fill        -> asserted, gated
//    - worker pixel deviates from the pure red fill      -> asserted, gated
//    - worker pixel === main pixel is not required (independent salts).
//  * performance.now(): the main thread clamps to whole milliseconds while
//    hardwareProtection is active (Math.floor, :2685-2706) -> main
//    fractional part is always 0 (asserted). The bootstrap does NOT hook
//    performance.now (only performance.memory) -> the worker keeps native
//    sub-ms precision. Worker sub-ms is recorded as info only: native timer
//    resolution is a browser property, not an engine contract.
const WORKER_PROBE_SRC = `
(function () {
  'use strict';
  function probe() {
    var out = {};
    try {
      var gl = new OffscreenCanvas(64, 64).getContext('webgl');
      var ext = gl.getExtension('WEBGL_debug_renderer_info');
      out.gpu = ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : null;
      out.vendor = ext ? gl.getParameter(ext.UNMASKED_VENDOR_WEBGL) : null;
      out.maxCombinedTextureUnits = gl.getParameter(0x8B4D);
    } catch (e) {
      out.webglError = String(e && e.message ? e.message : e);
    }
    try {
      var ctx = new OffscreenCanvas(4, 4).getContext('2d');
      ctx.fillStyle = 'rgb(255, 0, 0)';
      ctx.fillRect(0, 0, 4, 4);
      out.pixel = Array.from(ctx.getImageData(0, 0, 1, 1).data);
    } catch (e) {
      out.pixelError = String(e && e.message ? e.message : e);
    }
    var fracs = [];
    for (var i = 0; i < 12; i++) fracs.push(performance.now() % 1);
    out.nowFractions = fracs;
    out.subMsPrecisionObserved = fracs.some(function (f) { return f > 0; });
    return out;
  }
  self.onmessage = function () {
    try {
      self.postMessage(probe());
    } catch (e) {
      self.postMessage({ fatal: String(e && e.message ? e.message : e) });
    }
  };
})();
`;

const WORKER_PROBE_EXPRESSION = `(() => new Promise((resolve) => {
  const drawRedOffscreen = () => {
    const oc = new OffscreenCanvas(4, 4);
    const ctx = oc.getContext('2d');
    ctx.fillStyle = 'rgb(255, 0, 0)';
    ctx.fillRect(0, 0, 4, 4);
    return Array.from(ctx.getImageData(0, 0, 1, 1).data);
  };
  const main = {};
  try {
    main.pixelA = drawRedOffscreen();
    main.pixelB = drawRedOffscreen();
  } catch (e) {
    main.pixelError = String(e && e.message ? e.message : e);
  }
  try {
    const gl = document.createElement('canvas').getContext('webgl');
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    main.gpu = gl.getParameter(ext.UNMASKED_RENDERER_WEBGL);
    main.vendor = gl.getParameter(ext.UNMASKED_VENDOR_WEBGL);
    main.maxCombinedTextureUnits = gl.getParameter(0x8B4D);
  } catch (e) {
    main.gpuError = String(e && e.message ? e.message : e);
  }
  main.nowFractions = [];
  for (let i = 0; i < 12; i++) main.nowFractions.push(performance.now() % 1);

  let worker = null;
  let workerUrl = null;
  let settled = false;
  const finish = (payload) => {
    if (settled) return;
    settled = true;
    try { if (worker) worker.terminate(); } catch (e) {}
    try { if (workerUrl) URL.revokeObjectURL(workerUrl); } catch (e) {}
    resolve(payload);
  };
  try {
    const workerSrc = ${JSON.stringify(WORKER_PROBE_SRC)};
    const blob = new Blob([workerSrc], { type: 'application/javascript' });
    workerUrl = URL.createObjectURL(blob);
    worker = new Worker(workerUrl);
  } catch (e) {
    finish({ error: 'worker-create-failed: ' + String(e && e.message ? e.message : e), main });
    return;
  }
  const timer = setTimeout(() => finish({ error: 'worker-timeout-${WORKER_PROBE_TIMEOUT_MS}ms', main }), ${WORKER_PROBE_TIMEOUT_MS});
  worker.onmessage = (ev) => { clearTimeout(timer); finish({ main, worker: ev.data }); };
  worker.onerror = (ev) => { clearTimeout(timer); finish({ error: 'worker-error: ' + String(ev.message || 'unknown'), main }); };
  worker.postMessage('go');
}))()`;

// Reload-stability semantics — READ FROM ENGINE SOURCE, not guessed
// (content/stealth_engine.js):
//
//  * There is no cross-navigation session key in this engine (no
//    background-delivered key / "S1 handshake"). The farbling salt
//    GLOBAL_SESSION_SALT is generated per content-script evaluation
//    (:504-518, docstring: "Generated uniquely per page lifecycle.
//    Randomizes Canvas, WebGL, and Audio on every page reload/visit"), and
//    content scripts re-run at document_start on every navigation
//    (manifest.json) -> every reload mints a NEW salt. The per-domain seeds
//    are djb2(host:salt:canvas|webgl|audio) (:523-531) and the applyStealth
//    comment (:729-741) states this is deliberate: farbled values "stay
//    stable for one site during a page load, but differ across sites and
//    across visits" so fingerprints cannot be linked across sessions.
//  * Consequences for this probe:
//      - The farbled canvas pixel and audio sampleSum are NOT stable across
//        reload BY DESIGN (fresh per-load delta; a collision has p~1/12 for
//        canvas — canvasDelta takes 12 values — and p~1/50 for audio).
//        Cross-reload equality is therefore NOT gated; instead in-page
//        stability (same drawing on two canvases within one load -> the
//        hook's deterministic perturbPixel produces the identical farbled
//        pixel) IS gated, and cross-reload rotation is reported as info
//        (saltRotationObserved-style flags).
//      - The GPU renderer persona is chosen from a SALT-FREE key
//        (djb2(eTLD+1) % GPU_PROFILES.length, :787; comment :761-786: the
//        profile is "stable across reloads and sessions, like real
//        hardware") -> the renderer string MUST be identical before and
//        after reload. That equality IS gated.
const QUICK_PROBE_EXPRESSION = `(() => {
  const drawRedOffscreen = () => {
    const oc = new OffscreenCanvas(4, 4);
    const ctx = oc.getContext('2d');
    ctx.fillStyle = 'rgb(255, 0, 0)';
    ctx.fillRect(0, 0, 4, 4);
    return Array.from(ctx.getImageData(0, 0, 1, 1).data);
  };
  const out = {};
  out.pixelA = drawRedOffscreen();
  out.pixelB = drawRedOffscreen();
  try {
    const gl = document.createElement('canvas').getContext('webgl');
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    out.gpuRenderer = gl.getParameter(ext.UNMASKED_RENDERER_WEBGL);
    out.gpuVendor = gl.getParameter(ext.UNMASKED_VENDOR_WEBGL);
    out.maxCombinedTextureUnits = gl.getParameter(0x8B4D);
  } catch (e) {
    out.gpuError = String(e && e.message ? e.message : e);
  }
  const audioCtx = new OfflineAudioContext(1, 4096, 44100);
  const osc = audioCtx.createOscillator();
  osc.frequency.value = 10000;
  osc.connect(audioCtx.destination);
  osc.start(0);
  return audioCtx.startRendering().then((rendered) => {
    const data = rendered.getChannelData(0);
    let sum = 0;
    for (let i = 0; i < data.length; i++) sum += Math.abs(data[i]);
    out.audioSampleSum = sum;
    out.audioSampleCount = data.length;
    return out;
  });
})()`;

// Post-reload wait: the reloaded document is complete AND the engine's
// content script has re-applied (patch marks present on the new window).
const RELOAD_WAIT_EXPRESSION = `(() => ({
  readyState: document.readyState,
  url: location.href,
  marks: typeof window[Symbol.for('__bpc_pm_7e4b1c92')]
}))()`;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function pixelEquals(a, b) {
  return Array.isArray(a) && Array.isArray(b) &&
    a.length === b.length && a.every((v, i) => v === b[i]);
}

/**
 * Runtime.evaluate with returnByValue. opts: { awaitPromise, timeoutMs,
 * label }. The optional Node-side timeout only guards against a CDP send
 * that never settles (hung browser); the loser of the race gets a no-op
 * catch attached so it can never become an unhandled rejection.
 */
async function evalInPage(cdp, expression, opts = {}) {
  const params = { expression, returnByValue: true };
  if (opts.awaitPromise) params.awaitPromise = true;
  const sendP = cdp.send('Runtime.evaluate', params);
  sendP.catch(() => {});
  if (!opts.timeoutMs) return sendP;
  let timer;
  const timeoutP = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`Runtime.evaluate timed out after ${opts.timeoutMs}ms (${opts.label || 'unnamed probe'})`)),
      opts.timeoutMs
    );
  });
  try {
    return await Promise.race([sendP, timeoutP]);
  } finally {
    clearTimeout(timer);
  }
}

function evaluatedValue(res) {
  return (res && res.result && res.result.value !== undefined) ? res.result.value : null;
}

/** Poll the reloaded page until DOM complete + engine marks present. */
async function waitForReloadSettled(cdp, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    await h.sleep(500);
    try {
      const res = await cdp.send('Runtime.evaluate', {
        expression: RELOAD_WAIT_EXPRESSION,
        returnByValue: true
      });
      last = (res.result && res.result.value) || null;
      if (last && last.readyState === 'complete' && last.marks === 'object') return last;
    } catch (e) {
      // navigation commit in flight — context may be momentarily missing
    }
  }
  return last;
}

// ---------------------------------------------------------------------------
// Audit body (runs inside h.runWithRetry — fresh profile per attempt)
// ---------------------------------------------------------------------------

async function runAudit(ctx) {
  const { cdp } = ctx;
  const startedAt = new Date().toISOString();
  console.log(`Running CreepJS audit (${ctx.headed ? 'headed' : 'headless'}, bin=${ctx.bin}) against ${CREEP_URL}`);

  const uncaughtExceptions = [];
  // The frozen harness interface documents only send()/close(); .on is an
  // optional extra — guard so a minimal cdp implementation still works.
  if (typeof cdp.on === 'function') {
    cdp.on('Runtime.exceptionThrown', (params) => {
      uncaughtExceptions.push(params);
    });
  }

  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');

  console.log('Navigating to https://abrahamjuliot.github.io/creepjs/ ...');
  await cdp.send('Page.navigate', { url: CREEP_URL });

  // Wait for fingerprint generation (verbatim poll logic from the previous
  // version of this script).
  let finished = false;
  const startTime = Date.now();

  for (let i = 0; i < 60; i++) {
    await h.sleep(1000);
    try {
      const res = await cdp.send('Runtime.evaluate', {
        expression: STATUS_EXPRESSION,
        returnByValue: true
      });

      const status = res.result?.value;
      const elapsedSec = ((Date.now() - startTime) / 1000).toFixed(1);
      process.stdout.write(`\r[${elapsedSec}s] Status: fp=${status?.hasFP}, content=${status?.hasContent}, ready=${status?.readyState}`);

      // Creepjs finishes when window.Fingerprint is populated and has all data
      const checkDone = await cdp.send('Runtime.evaluate', {
        expression: DONE_EXPRESSION,
        returnByValue: true
      });

      if (checkDone.result?.value === true) {
        console.log('\nCreepJS fingerprint generated! Gathering detailed audit results...');
        finished = true;
        break;
      }
    } catch (err) {
      // ignore while loading
    }
  }

  if (!finished) {
    console.log('\nWarning: Timeout waiting for full Fingerprint completion, inspecting DOM anyway...');
  }

  // Give DOM 1 second to settle rendering
  await h.sleep(1000);

  // Engine sanity: fail loudly (EngineMissingError -> harness retries with a
  // fresh profile) when the extension did not apply. A bare browser produces
  // plausible-looking "good" numbers (totalLies = 0) that are meaningless.
  const engine = await h.ensureEngine(cdp);
  console.log('ENGINE SANITY:', JSON.stringify(engine.detail));

  const auditRes = await cdp.send('Runtime.evaluate', {
    expression: AUDIT_EXPRESSION,
    returnByValue: true
  });
  const val = auditRes.result?.value || {};

  console.log('\n================ UNCAUGHT EXCEPTIONS ================');
  console.log(`Count: ${uncaughtExceptions.length}`);
  uncaughtExceptions.forEach((e, idx) => {
    console.log(`[#${idx + 1}]`, JSON.stringify(e, null, 2));
  });
  console.log('====================================================\n');

  // ---- Worker-thread cross-context probe -------------------------------
  const wpRes = await evalInPage(cdp, WORKER_PROBE_EXPRESSION, {
    awaitPromise: true,
    timeoutMs: WORKER_PROBE_TIMEOUT_MS + 10000,
    label: 'worker probe'
  });
  const wpRaw = evaluatedValue(wpRes);
  const workerProbe = {
    error: (wpRaw && wpRaw.error) || (wpRaw ? null : 'no-result-from-page'),
    main: (wpRaw && wpRaw.main) || null,
    worker: (wpRaw && wpRaw.worker) || null
  };
  const wMain = workerProbe.main || {};
  const wWork = workerProbe.worker || {};

  console.log('================ WORKER PROBE ================');
  if (workerProbe.error) console.log('probe error:', workerProbe.error);
  console.log('main.gpu:      ', wMain.gpu);
  console.log('worker.gpu:    ', wWork.gpu);
  console.log('main.vendor:   ', wMain.vendor);
  console.log('worker.vendor: ', wWork.vendor);
  console.log('main.maxCombinedTextureUnits:   ', wMain.maxCombinedTextureUnits);
  console.log('worker.maxCombinedTextureUnits:', wWork.maxCombinedTextureUnits);
  console.log('main.pixel (OffscreenCanvas 2D red fill):  ', JSON.stringify(wMain.pixelA));
  console.log('worker.pixel (OffscreenCanvas 2D red fill):', JSON.stringify(wWork.pixel));
  console.log('main.nowFractions (engine clamps to whole ms):     ', JSON.stringify(wMain.nowFractions));
  console.log('worker.nowFractions (native, info only):           ', JSON.stringify(wWork.nowFractions));
  console.log('==============================================\n');

  // ---- Quick deterministic-fingerprint probe, run 1 ---------------------
  const q1Res = await evalInPage(cdp, QUICK_PROBE_EXPRESSION, {
    awaitPromise: true,
    timeoutMs: 15000,
    label: 'quick probe run 1'
  });
  const quick1 = evaluatedValue(q1Res);
  const q1 = quick1 || {};

  // ---- Reload + run 2 ----------------------------------------------------
  console.log('Reloading CreepJS page for stability probe ...');
  await cdp.send('Page.navigate', { url: CREEP_URL });
  const reloadState = await waitForReloadSettled(cdp);
  await h.sleep(1000);

  // Post-reload engine check: non-throwing — a missing engine here is a real
  // gate failure (the first audit was valid), not a retryable launch flake.
  const sanity2 = await h.engineSanity(cdp);

  const q2Res = await evalInPage(cdp, QUICK_PROBE_EXPRESSION, {
    awaitPromise: true,
    timeoutMs: 15000,
    label: 'quick probe run 2'
  });
  const quick2 = evaluatedValue(q2Res);
  const q2 = quick2 || {};

  const reloadStability = {
    run1: quick1,
    run2: quick2,
    reloadWaitState: reloadState,
    engineAppliedAfterReload: sanity2.ok === true,
    gpuRendererStableAcrossReload:
      typeof q1.gpuRenderer === 'string' && q1.gpuRenderer === q2.gpuRenderer,
    gpuVendorStableAcrossReload: q1.gpuVendor === q2.gpuVendor,
    canvasPixelStableAcrossReload: pixelEquals(q1.pixelA, q2.pixelA),
    // Expected true (fresh per-load salt); NOT gated — 1/12 delta collision
    // is a legitimate outcome, and stability here would be a design bug.
    canvasFarbleRotatedAcrossReload: !pixelEquals(q1.pixelA, q2.pixelA),
    audioSampleSumStableAcrossReload:
      typeof q1.audioSampleSum === 'number' && q1.audioSampleSum === q2.audioSampleSum
  };

  console.log('================ RELOAD STABILITY ================');
  console.log('gpuRenderer run1:', q1.gpuRenderer);
  console.log('gpuRenderer run2:', q2.gpuRenderer);
  console.log('gpuStableAcrossReload (gated):', reloadStability.gpuRendererStableAcrossReload);
  console.log('canvasPixel run1:', JSON.stringify(q1.pixelA));
  console.log('canvasPixel run2:', JSON.stringify(q2.pixelA));
  console.log('canvasFarbleRotatedAcrossReload (expected true, NOT gated — per-load salt by design):',
    reloadStability.canvasFarbleRotatedAcrossReload);
  console.log('audioSampleSum run1:', q1.audioSampleSum);
  console.log('audioSampleSum run2:', q2.audioSampleSum);
  console.log('audioSampleSumStableAcrossReload (NOT gated — per-load salt by design):',
    reloadStability.audioSampleSumStableAcrossReload);
  console.log('==================================================\n');

  // ---- Audit summary (existing key lines) --------------------------------
  console.log('================ AUDIT SUMMARY ================');
  console.log('trashBin:', JSON.stringify(val.trashBin));
  console.log('totalLies:', val.totalLies);
  console.log('capturedErrors:', JSON.stringify(val.capturedErrors));
  console.log('boldFailCount:', val.boldFailCount);
  if (val.boldFailDetails && val.boldFailDetails.length > 0) {
    console.log('boldFailDetails:', JSON.stringify(val.boldFailDetails, null, 2));
  }
  console.log('liesCount:', val.liesCount);
  if (val.liesDetails && val.liesDetails.length > 0) {
    console.log('liesDetails:', JSON.stringify(val.liesDetails, null, 2));
  }
  console.log('headlessGrade:', val.headlessGrade);
  console.log('stealthGrade:', val.stealthGrade);
  console.log('workerCurrency:', val.workerScope?.systemCurrencyLocale);
  console.log('audioInfo:', JSON.stringify(val.audioInfo, null, 2));
  console.log('===============================================\n');

  // ---- Gate evaluation ----------------------------------------------------
  // Gated: engine applied, lies budget, audio self-consistency, worker/main
  // GPU consistency, main-thread and worker 2D farble, main
  // timer clamp, in-page canvas determinism, cross-reload GPU persona
  // stability, engine re-applied after reload.
  // NOT gated (info only): headlessGrade/stealthGrade (environment-bound),
  // worker sub-ms timers (native browser property), cross-reload canvas
  // pixel / audio sum equality (per-load salt — anti-linking by design).
  const gateChecks = [];
  const addCheck = (name, pass, detail) => {
    gateChecks.push({ name, pass: pass === true, detail: detail === undefined ? null : detail });
  };

  // Reaching this point means ensureEngine passed (it throws otherwise and
  // the harness retries / rethrows); recorded explicitly for the report.
  addCheck('engineApplied', engine.ok === true, engine.detail);
  addCheck(`totalLies<=${GATE.maxTotalLies}`,
    typeof val.totalLies === 'number' && val.totalLies <= GATE.maxTotalLies,
    { totalLies: val.totalLies, max: GATE.maxTotalLies });
  // AudioBuffer farbling is idempotent per (buffer, channel) and shared
  // across getChannelData/copyFromChannel (stealth_engine.js:1482-1500), so
  // CreepJS's bins-vs-copy comparison must stay consistent under farbling.
  addCheck('audioMatching',
    !!(val.audioInfo && val.audioInfo.matching === true),
    val.audioInfo ? { matching: val.audioInfo.matching } : { audioInfo: null });
  addCheck('workerRendererMatchesMain',
    typeof wMain.gpu === 'string' && wMain.gpu === wWork.gpu,
    { main: wMain.gpu, worker: wWork.gpu, probeError: workerProbe.error });
  addCheck('workerVendorMatchesMain',
    typeof wMain.vendor === 'string' && wMain.vendor === wWork.vendor,
    { main: wMain.vendor, worker: wWork.vendor });
  addCheck('workerMaxCombinedMatchesMain',
    typeof wMain.maxCombinedTextureUnits === 'number' &&
      wMain.maxCombinedTextureUnits === wWork.maxCombinedTextureUnits,
    { main: wMain.maxCombinedTextureUnits, worker: wWork.maxCombinedTextureUnits });
  // Main-thread OffscreenCanvas 2D farble: R channel perturbed away from the
  // pure fill's 255, G/B untouched, alpha untouched (opaque fill) — the
  // exact shape of the getImageData hook (stealth_engine.js:826-837).
  addCheck('mainOffscreenCanvasFarbled',
    Array.isArray(wMain.pixelA) && wMain.pixelA.length === 4 &&
      wMain.pixelA[1] === 0 && wMain.pixelA[2] === 0 && wMain.pixelA[3] === 255 &&
      wMain.pixelA[0] !== 255,
    { pixel: wMain.pixelA, pureFill: PURE_RED_FILL });
  // Worker 2D is farbled by the worker bootstrap's OffscreenCanvas hooks.
  addCheck('workerOffscreenCanvasFarbled',
    Array.isArray(wWork.pixel) && wWork.pixel.length === 4 &&
      wWork.pixel[1] === 0 && wWork.pixel[2] === 0 && wWork.pixel[3] === 255 &&
      wWork.pixel[0] !== 255,
    { pixel: wWork.pixel, pureFill: PURE_RED_FILL });
  addCheck('mainNowClampedToMs',
    Array.isArray(wMain.nowFractions) && wMain.nowFractions.length > 0 &&
      wMain.nowFractions.every((f) => f === 0),
    { nowFractions: wMain.nowFractions });
  addCheck('canvasInPageStableRun1',
    pixelEquals(q1.pixelA, q1.pixelB),
    { pixelA: q1.pixelA, pixelB: q1.pixelB });
  addCheck('canvasInPageStableRun2',
    pixelEquals(q2.pixelA, q2.pixelB),
    { pixelA: q2.pixelA, pixelB: q2.pixelB });
  addCheck('gpuStableAcrossReload',
    typeof q1.gpuRenderer === 'string' && q1.gpuRenderer === q2.gpuRenderer,
    { run1: q1.gpuRenderer, run2: q2.gpuRenderer });
  addCheck('engineAppliedAfterReload', sanity2.ok === true, sanity2.detail);

  const failedChecks = gateChecks.filter((c) => !c.pass).map((c) => c.name);
  const gate = {
    maxTotalLies: GATE.maxTotalLies,
    checks: gateChecks,
    failed: failedChecks,
    pass: failedChecks.length === 0
  };

  console.log('GATE checks:');
  gateChecks.forEach((c) => console.log(`  [${c.pass ? 'PASS' : 'FAIL'}] ${c.name}`));
  console.log('');

  // ---- Report -------------------------------------------------------------
  const finishedAt = new Date().toISOString();
  const report = {
    startedAt,
    finishedAt,
    durationMs: Date.now() - startTime,
    headed: ctx.headed,
    chromeBin: ctx.bin,
    creepUrl: CREEP_URL,
    fingerprintCompleted: finished,
    engineSanity: engine.detail,
    engineSanityAfterReload: sanity2.detail,
    totalLies: val.totalLies,
    liesCount: val.liesCount,
    boldFailCount: val.boldFailCount,
    headlessGrade: val.headlessGrade,
    stealthGrade: val.stealthGrade,
    trashBin: val.trashBin,
    capturedErrors: val.capturedErrors,
    lies: val.liesDetails,
    boldFails: val.boldFailDetails,
    audioInfo: val.audioInfo,
    canvas2dInfo: val.canvas2dInfo,
    workerScope: val.workerScope,
    webrtc: val.webrtc,
    canvasWebgl: val.canvasWebgl,
    fonts: val.fonts,
    screen: val.screen,
    resistance: val.resistance,
    uncaughtExceptions: {
      count: uncaughtExceptions.length,
      details: uncaughtExceptions
    },
    workerProbe,
    reloadStability,
    gate
  };

  return report;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

async function main() {
  // runWithRetry: up to 2 attempts, each with a fresh profile; retries when
  // launch fails or the body throws EngineMissingError; auto-cleanup.
  const report = await h.runWithRetry('creep', { headed: process.env.HEADED === '1' }, runAudit);

  const reportPath = h.saveReport('creep', report);
  console.log(`Report saved: ${reportPath}`);

  if (report.gate.pass) {
    console.log('GATE: PASS');
  } else {
    console.log(`GATE: FAIL — ${report.gate.failed.join(', ')}`);
    process.exitCode = 1;
  }
}

main().catch(err => {
  console.error('Fatal error in verify:', err);
  process.exit(1);
});
