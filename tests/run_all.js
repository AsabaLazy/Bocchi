#!/usr/bin/env node
'use strict';

/**
 * Unified test entry point for the Bocchi extension.
 *
 * Usage: node tests/run_all.js <mode>
 * Run without arguments to see all available modes.
 */

const { spawnSync } = require('child_process');
const path = require('path');

const REPO_ROOT = path.join(__dirname, '..');
const NODE = process.execPath; // always reuse the Node binary running this runner

const UNIT_SCRIPT = path.join(__dirname, 'stealth.test.js');
const PACKAGE_SCRIPT = path.join(REPO_ROOT, 'package-extension.sh');
const EXTENSION_SMOKE_SCRIPT = path.join(__dirname, 'extension_smoke.js');
const EXTENSION_SMOKE_MARKER = 'EXTENSION SMOKE PASSED';

// Success markers are part of the gate: an exit code of 0 without evidence
// means the assertions never ran (e.g. a swallowed async failure).
const UNIT_SUCCESS_MARKER = '=== ALL TESTS PASSED SUCCESSFULLY! ===';
// The suite currently executes ~700 assertions. The floor is intentionally
// well below that but far above zero, so a skipped/aborted body cannot pass.
const MIN_UNIT_ASSERTIONS = 650;
const PACKAGE_SUCCESS_RE = /PACKAGING VERIFY OK \((\d+) files, v([0-9][0-9.]*)\)/;

// Timezone portability matrix for the unit suite.
const TZ_MATRIX = [
  'America/Los_Angeles',
  'Asia/Tokyo',
  'Europe/Paris',
  'America/New_York',
  'UTC',
];

// Live scripts, run strictly in this order: the browser is heavy and the
// apivoid checks are rate-limited, so nothing here may run in parallel.
const LIVE_SCRIPTS = [
  'live_creep_verify.js',
  'check_apivoid_live.js',
  'diagnose_apivoid.js',
  'test_apivoid_tamper.js',
];

/**
 * Run a Node script synchronously.
 * @param {string} script absolute path to the script
 * @param {{env?: Object, inherit?: boolean}} opts
 *   env    environment for the child (defaults to the runner's environment)
 *   inherit pass stdio through to this process instead of capturing it
 */
function runNode(script, { env = process.env, inherit = false, args = [] } = {}) {
  const result = spawnSync(NODE, [script, ...args], {
    cwd: REPO_ROOT,
    env,
    ...(inherit ? { stdio: 'inherit' } : { encoding: 'utf8' }),
  });
  return {
    ok: !result.error && result.status === 0,
    status: result.status,
    error: result.error,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
  };
}

/* ------------------------------------------------------------------ modes */

/**
 * Validate the unit suite's captured output beyond its exit code. Requires
 * the explicit success marker AND an assertion count above the floor.
 * @returns {{ok: boolean, count: number|null, reason?: string}}
 */
function validateUnitOutput(stdout) {
  if (!stdout.includes(UNIT_SUCCESS_MARKER)) {
    return { ok: false, count: null, reason: 'missing "ALL TESTS PASSED" marker' };
  }
  const match = stdout.match(/(?:^|\n)ASSERTION_COUNT=(\d+)(?:\n|$)/);
  if (!match) {
    return { ok: false, count: null, reason: 'missing ASSERTION_COUNT line' };
  }
  const count = Number(match[1]);
  if (!Number.isSafeInteger(count) || count < MIN_UNIT_ASSERTIONS) {
    return { ok: false, count, reason: `assertion count ${count} < required ${MIN_UNIT_ASSERTIONS}` };
  }
  return { ok: true, count };
}

function modeUnit() {
  console.log('=== [unit] tests/stealth.test.js ===\n');
  // Capture (instead of inherit) so the success marker and assertion count
  // can be verified in addition to the exit code; still echo everything.
  const r = runNode(UNIT_SCRIPT);
  if (r.stdout) process.stdout.write(r.stdout);
  if (r.stderr) process.stderr.write(r.stderr);
  if (r.error) {
    console.error(`Failed to start unit suite: ${r.error.message}`);
    return 1;
  }
  if (r.status !== 0) return r.status === null ? 1 : r.status;
  const gate = validateUnitOutput(r.stdout);
  if (!gate.ok) {
    console.error(`Unit gate FAILED: ${gate.reason}`);
    return 1;
  }
  console.log(`\n[gate] unit assertions: ${gate.count} (>= ${MIN_UNIT_ASSERTIONS})`);
  return 0;
}

function modeTz() {
  const width = Math.max(...TZ_MATRIX.map((tz) => tz.length));
  console.log(`=== [tz] unit suite across ${TZ_MATRIX.length} timezones ===`);

  const rows = [];
  for (const tz of TZ_MATRIX) {
    process.stdout.write(`  ${tz.padEnd(width)} ... `);
    const start = Date.now();
    // Fresh process per TZ: Node reads TZ only at startup.
    const r = runNode(UNIT_SCRIPT, { env: { ...process.env, TZ: tz } });
    const elapsed = Date.now() - start;
    const gate = r.ok ? validateUnitOutput(r.stdout) : { ok: false, reason: `exit ${r.status}` };
    const passed = r.ok && gate.ok;
    rows.push({ tz, r, gate, passed, elapsed });
    console.log(passed ? `PASS (${elapsed} ms)` : 'FAIL');
    if (!passed) {
      // Surface the failing run's captured output for debugging.
      if (r.error) console.error(`  spawn error: ${r.error.message}`);
      if (!gate.ok) console.error(`  gate: ${gate.reason}`);
      if (r.stdout) process.stdout.write(r.stdout);
      if (r.stderr) process.stderr.write(r.stderr);
    }
  }

  console.log(`\nTZ Summary (unit suite):`);
  console.log(`  ${'TZ'.padEnd(width)} | Result | Duration`);
  console.log(`  ${'-'.repeat(width)}-+--------+---------`);
  for (const { tz, passed, elapsed } of rows) {
    console.log(`  ${tz.padEnd(width)} | ${(passed ? 'PASS' : 'FAIL').padEnd(6)} | ${elapsed} ms`);
  }
  return rows.every(({ passed }) => passed) ? 0 : 1;
}

/**
 * Package mode: build the distribution zip and require both a clean exit and the
 * exact allowlist/version verification marker emitted by
 * package-extension.sh. This prevents a "zero files packaged" success from
 * slipping through as exit 0.
 */
function modePackage() {
  console.log('=== [package] package-extension.sh (allowlist + version gate) ===\n');
  const result = spawnSync('bash', [PACKAGE_SCRIPT], {
    cwd: REPO_ROOT,
    env: process.env,
    encoding: 'utf8',
  });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.error) {
    console.error(`Failed to start package-extension.sh: ${result.error.message}`);
    return 1;
  }
  if (result.status !== 0) {
    console.error(`Package gate FAILED: package-extension.sh exited ${result.status}`);
    return 1;
  }
  const match = (result.stdout || '').match(PACKAGE_SUCCESS_RE);
  if (!match) {
    console.error('Package gate FAILED: missing "PACKAGING VERIFY OK (<n> files, v<version>)" marker');
    return 1;
  }
  const fileCount = Number(match[1]);
  if (!Number.isSafeInteger(fileCount) || fileCount <= 0) {
    console.error(`Package gate FAILED: invalid packaging file count ${match[1]}`);
    return 1;
  }
  console.log(`\n[gate] package verified: ${fileCount} files, v${match[2]}`);
  return 0;
}

function modeExtension() {
  console.log('=== [extension] real-browser registration/injection smoke ===\n');
  const result = runNode(EXTENSION_SMOKE_SCRIPT);
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.error) {
    console.error(`Failed to start extension smoke: ${result.error.message}`);
    return 1;
  }
  if (result.status !== 0) return result.status === null ? 1 : result.status;
  if (!result.stdout.includes(EXTENSION_SMOKE_MARKER)) {
    console.error('Extension smoke gate FAILED: missing success marker');
    return 1;
  }
  console.log('\n[gate] extension smoke verified');
  return 0;
}

function modeLive(headed) {
  const label = headed ? 'headed' : 'live';
  const width = Math.max(...LIVE_SCRIPTS.map((s) => s.length));
  console.log(`=== [${label}] ${LIVE_SCRIPTS.length} live scripts, sequential ===`);

  // The whole environment is inherited, so CHROME_BIN (when set) is passed
  // through to every live script.
  const env = { ...process.env };
  if (headed) env.HEADED = '1';

  const rows = [];
  for (const script of LIVE_SCRIPTS) {
    console.log(`\n--- ${script} ---`);
    const r = runNode(path.join(__dirname, script), { env, inherit: true });
    rows.push({ script, r });
  }

  console.log(`\n${label[0].toUpperCase() + label.slice(1)} Summary:`);
  console.log(`  ${'Script'.padEnd(width)} | Exit | Result`);
  console.log(`  ${'-'.repeat(width)}-+------+--------`);
  for (const { script, r } of rows) {
    const exit = r.error ? (r.error.code || 'ERR') : r.status;
    console.log(`  ${script.padEnd(width)} | ${String(exit).padStart(4)} | ${r.ok ? 'PASS' : 'FAIL'}`);
  }
  return rows.every(({ r }) => r.ok) ? 0 : 1;
}

/* Bench and soak are on-demand single-script modes: both need a real
 * Chromium (so they are NOT part of unit/tz/package CI gates), the benchmark
 * is gated by thresholds and the soak takes ~30 minutes by default. Neither
 * belongs in the `live` regression chain or in `all`. */
function modeScript(script, label, extraArgs = []) {
  console.log(`=== [${label}] ${script} ${extraArgs.join(' ')}===`);
  console.log(`[${label}] DIAGNOSTIC: requires Chromium with the extension loaded (CHROME_BIN).`);
  const r = runNode(path.join(__dirname, script), { inherit: true, args: extraArgs });
  const exit = r.error ? (r.error.code || 'ERR') : r.status;
  console.log(`\n${label}: ${script} -> ${r.ok ? 'PASS' : `FAIL (exit ${exit})`}`);
  return r.ok ? 0 : 1;
}

function modeAll() {
  const stages = [
    ['unit', modeUnit],
    ['tz', modeTz],
    ['live', () => modeLive(false)],
  ];
  const rows = [];
  for (const [name, fn] of stages) {
    console.log(`\n########## stage: ${name} ##########`);
    rows.push({ name, code: fn() });
  }

  console.log('\nAll Summary:');
  for (const { name, code } of rows) {
    console.log(`  ${name.padEnd(5)} | ${code === 0 ? 'PASS' : `FAIL (exit ${code})`}`);
  }
  return rows.every(({ code }) => code === 0) ? 0 : 1;
}

/* ------------------------------------------------------------------ usage */

function printUsage() {
  console.log(`Bocchi - unified test runner

Usage:
  node tests/run_all.js <mode>

Modes:
  unit     Run the unit suite (tests/stealth.test.js) once, capturing output;
           the exit code, the "ALL TESTS PASSED" marker and an assertion
           count >= ${MIN_UNIT_ASSERTIONS} are all required.
  tz       Run the unit suite once per timezone in the portability matrix
           (${TZ_MATRIX.join(', ')}) and print a summary table
           (TZ | result | duration). Each run must pass the same
           marker/count gate. Exits 1 if any timezone fails.
  package  Build the distribution zip with package-extension.sh and require its
           "PACKAGING VERIFY OK (<n> files, v<version>)" marker (exact file
           allowlist + manifest/package.json/CHANGELOG version agreement).
           No browser required.
  extension Run tests/extension_smoke.js in a real Chrome for Testing /
           Chromium: verifies dynamic registration, bridge injection, Date /
           canvas / font / WebRTC behavior and bypass-site non-injection.
           Requires CHROME_BIN. Not part of the network-free CI unit job.
  live     Run the live browser scripts sequentially, in this order:
           ${LIVE_SCRIPTS.join(' -> ')}
           stdio is inherited and CHROME_BIN is passed through from the
           environment. Exits 1 if any script fails. Nothing runs in
           parallel: the browser is heavy and apivoid is rate-limited.
           DIAGNOSTIC: requires a Chromium binary; not part of CI gates.
  headed   Same as live, but every script is launched with HEADED=1
           (visible browser windows).
  all      unit -> tz -> live, in that order.
           Exits 1 if any stage failed.
  bench    Run the engine-hook performance benchmark (perf_bench.js, ~10s).
           DIAGNOSTIC: requires Chromium. hardwareTimer is disabled before
           navigation so performance.now() is unclamped; fails (exit 1) on
           malformed metrics or when a metric exceeds its threshold.
           Override limits with BENCH_MAX_<METRIC>.
  soak     Run the long-run leak soak (soak_verify.js, default 30 minutes).
           DIAGNOSTIC: requires Chromium. Pass a duration in minutes:
           \`node tests/run_all.js soak 5\` (the gate needs >= 5 samples, so
           prefer >= 7 minutes). Fails on leakage, insufficient samples,
           excessive cycle failures or an engine loss at the end.

Environment (live/headed/bench/soak modes):
  CHROME_BIN  Path to the Chrome/Chromium binary for the live scripts.
  HEADED=1    Force a visible browser (set automatically by the headed mode).
`);
}

/* ------------------------------------------------------------------- main */

const MODES = {
  unit: modeUnit,
  tz: modeTz,
  package: modePackage,
  extension: modeExtension,
  live: () => modeLive(false),
  headed: () => modeLive(true),
  all: modeAll,
  bench: () => modeScript('perf_bench.js', 'bench'),
  soak: () => modeScript('soak_verify.js', 'soak', process.argv.slice(3)),
};

const mode = process.argv[2];

if (!mode) {
  printUsage();
  process.exitCode = 1; // nothing was run; a bare invocation must not look green
} else if (!MODES[mode]) {
  console.error(`Unknown mode: ${mode}\n`);
  printUsage();
  process.exitCode = 1;
} else {
  process.exitCode = MODES[mode]();
}
