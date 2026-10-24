'use strict';

/**
 * tests/lib/live_harness.js — shared harness for the live (real-Chromium)
 * test scripts. Extracted from the ~60-line inline copy that used to live in
 * every live script: a minimal CDP-over-WebSocket client, the Chromium launch
 * flags, and the HTTP polling that waits for the DevTools endpoint.
 *
 * Exports: { sleep, resolveChromeBin, freePort, launch, engineSanity,
 *            ensureEngine, cleanup, saveReport, runWithRetry, EngineMissingError }
 *
 * CommonJS, node stdlib only. Requires Node >= 22 for the global WebSocket.
 *
 * NOTE: branded Google Chrome 137+ silently ignores --load-extension; use
 * Chromium or Chrome for Testing, or point CHROME_BIN at such a build.
 */

const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');

// The harness speaks CDP over the global WebSocket added in Node 22. Fail with
// a direct explanation instead of a bare `ReferenceError: WebSocket is not
// defined` on older runtimes (CI pins 22; package.json declares engines).
if (typeof WebSocket !== 'function') {
  throw new Error(
    `tests/lib/live_harness.js requires Node >= 22 (global WebSocket); current is ${process.version}`
  );
}

// Patch mark the extension engine leaves on the page window once the content
// script has applied. This is an *expression snippet* (not a bare key) that
// gets interpolated into Runtime.evaluate expressions.
const ENGINE_MARKS_SYMBOL = "Symbol.for('__bpc_pm_7e4b1c92')";

// tests/lib/ -> repository root == the extension itself.
const EXT_ROOT = path.resolve(__dirname, '..', '..');

class EngineMissingError extends Error {
  constructor(detail) {
    super('EXTENSION DID NOT APPLY: ' + JSON.stringify(detail));
    this.name = 'EngineMissingError';
    this.detail = detail;
  }
}

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Pick a Chromium binary: process.env.CHROME_BIN (returned verbatim, not
 * validated) -> 'chromium' -> 'chromium-browser' (existence probed via
 * `which`). Branded google-chrome-stable is deliberately not accepted:
 * since Chrome 137 it ignores --load-extension, so the extension would
 * silently never load.
 */
function resolveChromeBin() {
  if (process.env.CHROME_BIN) return process.env.CHROME_BIN;
  for (const candidate of ['chromium', 'chromium-browser']) {
    const probe = spawnSync('which', [candidate], { stdio: 'ignore' });
    if (probe.status === 0) return candidate;
  }
  throw new Error(
    'No Chromium binary found (tried CHROME_BIN, chromium, chromium-browser). ' +
    'Branded google-chrome-stable ignores --load-extension since Chrome 137; ' +
    'use Chromium or Chrome for Testing, or set CHROME_BIN to such a binary.'
  );
}

/** Grab a free TCP port on 127.0.0.1 (bind to :0, read it back, close). */
async function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
}

/**
 * HTTP GET returning parsed JSON; a non-JSON body resolves as the raw string
 * and the caller validates the shape (same semantics as the inline helpers
 * the live scripts used).
 */
function httpGetJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          resolve(data);
        }
      });
    }).on('error', reject);
  });
}

/**
 * Minimal CDP client over the global WebSocket, ported from the
 * battle-tested inline clients in tests/live_creep_verify.js and
 * tests/check_apivoid_live.js. Usage:
 *
 *   const cdp = new CDPClient(wsUrl);
 *   await cdp.open();                          // alias of the `ready` promise
 *   await cdp.send('Page.enable');             // -> result; rejects on protocol error
 *   cdp.on('Runtime.exceptionThrown', fn);     // optional event subscription
 *   cdp.close();
 */
class CDPClient {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl);
    this.id = 1;
    this.callbacks = new Map();
    this.events = new Map();

    this.ready = new Promise((resolve, reject) => {
      this.ws.onopen = resolve;
      this.ws.onerror = reject;
    });

    this.ws.onmessage = (event) => {
      const msg = JSON.parse(event.data);
      if (msg.id && this.callbacks.has(msg.id)) {
        const { resolve, reject } = this.callbacks.get(msg.id);
        this.callbacks.delete(msg.id);
        if (msg.error) reject(msg.error);
        else resolve(msg.result);
      } else if (msg.method) {
        const handlers = this.events.get(msg.method) || [];
        handlers.forEach(h => h(msg.params));
      }
    };
  }

  open() {
    return this.ready;
  }

  send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const msgId = this.id++;
      this.callbacks.set(msgId, { resolve, reject });
      this.ws.send(JSON.stringify({ id: msgId, method, params }));
    });
  }

  on(event, handler) {
    if (!this.events.has(event)) this.events.set(event, []);
    this.events.get(event).push(handler);
  }

  close() {
    this.ws.close();
  }
}

/**
 * Wait for Chromium's DevTools HTTP endpoint, then attach to the page
 * target. Polls /json/version until the browser is up (within timeoutMs),
 * then /json/list for a type === 'page' target and opens its debug
 * WebSocket. Returns the connected CDPClient.
 */
async function connectCDP(port, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;

  let version = null;
  while (Date.now() < deadline) {
    try {
      version = await httpGetJson(`http://127.0.0.1:${port}/json/version`);
      if (version && typeof version === 'object' && version.Browser) break;
      version = null;
    } catch (e) { /* browser not up yet */ }
    await sleep(200);
  }
  if (!version) {
    throw new Error(
      `Chromium CDP not ready at http://127.0.0.1:${port}/json/version within ${timeoutMs}ms`
    );
  }

  let targets = null;
  while (Date.now() < deadline) {
    try {
      targets = await httpGetJson(`http://127.0.0.1:${port}/json/list`);
      if (Array.isArray(targets) && targets.length > 0) break;
      targets = null;
    } catch (e) { /* page target not registered yet */ }
    await sleep(200);
  }
  if (!targets || targets.length === 0) {
    throw new Error('Failed to connect to Chromium CDP port (no targets listed)');
  }

  const pageTarget = targets.find(t => t.type === 'page');
  if (!pageTarget) throw new Error('No page target found');

  const client = new CDPClient(pageTarget.webSocketDebuggerUrl);
  await client.open();
  return client;
}

/**
 * Start an off-screen Xvfb display for headed runs. The user's desktop is
 * never touched, while Chromium still sees a normal (non-headless) display,
 * which keeps UA/JS surfaces realistic for risk-control testing.
 * Throws with install instructions when Xvfb is missing and the caller did
 * not opt into on-screen windows (BOCCHI_TEST_ONSCREEN=1).
 */
async function startXvfb() {
  const candidates = ['Xvfb'];
  let bin = null;
  for (const c of candidates) {
    const which = spawnSync('sh', ['-c', `command -v ${c}`], { encoding: 'utf8' });
    if (which.status === 0 && which.stdout.trim()) { bin = which.stdout.trim(); break; }
  }
  if (!bin) {
    const err = new Error(
      'Headed runs use an off-screen Xvfb display so they never disturb the desktop, ' +
      'but Xvfb is not installed. Install it (Arch: sudo pacman -S xorg-server-xvfb) ' +
      'or set BOCCHI_TEST_ONSCREEN=1 to allow a real window.'
    );
    err.fatal = true; // configuration problem: retrying cannot help
    throw err;
  }
  // Pick a free display number.
  let displayNum = 90 + Math.floor(Math.random() * 9);
  for (let i = 0; i < 20; i++) {
    if (!fs.existsSync(`/tmp/.X11-unix/X${displayNum}`) && !fs.existsSync(`/tmp/.X${displayNum}-lock`)) break;
    displayNum = 90 + Math.floor(Math.random() * 9);
  }
  const display = `:${displayNum}`;
  const proc = spawn(bin, [display, '-screen', '0', '1280x900x24', '-nolisten', 'tcp'], { stdio: 'ignore' });
  for (let i = 0; i < 40; i++) {
    if (fs.existsSync(`/tmp/.X11-unix/X${displayNum}`)) return { display, proc };
    await sleep(100);
  }
  try { proc.kill('SIGKILL'); } catch (_) {}
  throw new Error(`Xvfb failed to start on ${display}`);
}

/**
 * Launch Chromium with a fresh profile and the repo-root extension loaded.
 * Returns { chromeProcess, cdp, tempDir, port, bin, headed, xvfbProcess }.
 * Headless by default; opts.headed === true runs with a normal browser
 * window on an off-screen Xvfb display (no desktop disturbance; set
 * BOCCHI_TEST_ONSCREEN=1 for a visible window on the real desktop).
 * If the CDP connection fails, the process is killed and the error rethrown
 * (runWithRetry treats that as transient).
 */
async function launch(opts = {}) {
  const bin = resolveChromeBin();
  const port = await freePort();
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bocchi-live-'));
  const headed = !!opts.headed;

  const args = [
    '--no-sandbox',
    `--user-data-dir=${tempDir}`,
    `--remote-debugging-port=${port}`,
    `--load-extension=${EXT_ROOT}`,
    `--disable-extensions-except=${EXT_ROOT}`,
    'about:blank'
  ];
  if (!headed) args.unshift('--headless=new', '--disable-gpu');

  let env = process.env;
  let xvfbProcess = null;
  if (headed && !process.env.BOCCHI_TEST_ONSCREEN) {
    const xvfb = await startXvfb();
    xvfbProcess = xvfb.proc;
    env = { ...process.env, DISPLAY: xvfb.display };
    delete env.WAYLAND_DISPLAY; // force the X11 backend inside Xvfb
    args.push('--ozone-platform=x11');
  }

  const chromeProcess = spawn(bin, args, { stdio: 'ignore', env });
  // A missing binary surfaces as an async 'error' event, not a synchronous
  // throw; race it against the CDP wait so launch() rejects promptly instead
  // of crashing on an unhandled 'error' event or polling a dead port.
  // Promise.race attaches handlers to both, so the loser never becomes an
  // unhandled rejection.
  const spawnFailed = new Promise((resolve, reject) => {
    chromeProcess.once('error', reject);
  });

  let cdp;
  try {
    cdp = await Promise.race([connectCDP(port), spawnFailed]);
  } catch (err) {
    killAndRemove(chromeProcess, tempDir);
    if (xvfbProcess) { try { xvfbProcess.kill('SIGKILL'); } catch (_) {} }
    throw err;
  }
  return { chromeProcess, cdp, tempDir, port, bin, headed, xvfbProcess };
}

/**
 * Verify the extension engine actually applied. MUST be called after
 * navigating to a real http(s) page — content scripts do not run on the
 * initial about:blank, so an early call would false-negative.
 * Returns { ok, detail: { marks, gpu } } where ok === (marks === 'object').
 */
async function engineSanity(cdp) {
  const res = await cdp.send('Runtime.evaluate', {
    expression: `(() => {
      let gpu = 'n/a';
      try { const gl = document.createElement('canvas').getContext('webgl');
        const ext = gl.getExtension('WEBGL_debug_renderer_info');
        gpu = gl.getParameter(ext.UNMASKED_RENDERER_WEBGL); } catch (e) {}
      return { marks: typeof window[${ENGINE_MARKS_SYMBOL}], gpu };
    })()`,
    returnByValue: true
  });
  const detail = (res && res.result && res.result.value) || {};
  const ok = detail.marks === 'object';
  if (!ok) {
    console.log('!!!!! EXTENSION DID NOT APPLY — everything below is a BARE BROWSER, not the extension. !!!!!');
    console.log('!!!!! Check that CHROME_BIN is Chromium / Chrome for Testing (branded Chrome 137+ ignores --load-extension). !!!!!');
  }
  return { ok, detail };
}

/**
 * engineSanity, but throws EngineMissingError when the engine did not apply
 * (runWithRetry treats that as transient and retries with a fresh profile).
 */
async function ensureEngine(cdp) {
  const result = await engineSanity(cdp);
  if (!result.ok) throw new EngineMissingError(result.detail);
  return result;
}

/** Idempotent teardown of a launch() context; safe to call twice. */
function removeTempDir(tempDir) {
  try {
    fs.rmSync(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch (_) {}
}

// Chrome flushes profile state (recreating Default/{Cache, Network Persistent
// State}) as it shuts down; removing the profile right after SIGTERM races
// those writes and leaks a skeleton temp dir per run. Wait for actual exit —
// with SIGKILL escalation and a timer fallback — before removing.
function killAndRemove(proc, tempDir) {
  const remove = () => removeTempDir(tempDir);
  if (proc && proc.exitCode === null && proc.signalCode === null) {
    try { proc.kill('SIGTERM'); } catch (_) {}
    const killTimer = setTimeout(() => {
      try { proc.kill('SIGKILL'); } catch (_) {}
    }, 3000);
    proc.once('exit', () => {
      clearTimeout(killTimer);
      remove();
    });
    // Fallback if 'exit' never fires (e.g. it fired before we attached).
    setTimeout(() => {
      clearTimeout(killTimer);
      remove();
    }, 6000).unref();
  } else {
    // Already dead (or never started): its shutdown writes are done.
    try { if (proc) proc.kill('SIGKILL'); } catch (_) {}
    remove();
  }
}

function cleanup(ctx) {
  if (!ctx) return;
  try { if (ctx.cdp) ctx.cdp.close(); } catch (_) {}
  killAndRemove(ctx.chromeProcess, ctx.tempDir);
  if (ctx.xvfbProcess) { try { ctx.xvfbProcess.kill('SIGKILL'); } catch (_) {} }
}

/**
 * Write `data` as pretty-printed JSON to
 * tests/reports/<name>-<YYYYMMDD-HHMMSS>-<pid>.json (UTC timestamp) and
 * return the absolute path.
 */
function saveReport(name, data) {
  const dir = path.resolve(__dirname, '..', 'reports');
  fs.mkdirSync(dir, { recursive: true });
  const now = new Date();
  const pad = n => String(n).padStart(2, '0');
  const stamp =
    `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}` +
    `-${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}`;
  const file = path.join(dir, `${name}-${stamp}-${process.pid}.json`);
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
  return file;
}

/**
 * Run body(ctx) with at most 2 launch attempts, each with a fresh profile.
 * A failure is retried once when launch/connect threw (transient startup
 * failure — ctx was never created) or when body threw EngineMissingError
 * (extension transiently not loaded). Any other body error is rethrown
 * immediately. Returns body's return value.
 */
async function runWithRetry(name, opts, body) {
  for (let attempt = 1; attempt <= 2; attempt++) {
    let ctx = null;
    try {
      ctx = await launch(opts);
      return await body(ctx);
    } catch (err) {
      const transient = !err.fatal && (ctx === null || err instanceof EngineMissingError);
      if (attempt === 1 && transient) {
        console.log(`${name}: attempt 1 failed (${err.message}), retrying with a fresh profile...`);
        continue;
      }
      throw err;
    } finally {
      if (ctx) cleanup(ctx);
    }
  }
}

module.exports = {
  sleep,
  resolveChromeBin,
  freePort,
  launch,
  engineSanity,
  ensureEngine,
  cleanup,
  saveReport,
  runWithRetry,
  EngineMissingError,
  CDPClient
};
