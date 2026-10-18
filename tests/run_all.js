#!/usr/bin/env node
'use strict';

/**
 * Unified test entry point for the Bocchi Privacy Shield extension.
 *
 * Usage: node tests/run_all.js <mode>
 * Run without arguments to see all available modes.
 */

const { spawnSync } = require('child_process');
const path = require('path');

const REPO_ROOT = path.join(__dirname, '..');
const NODE = process.execPath; // always reuse the Node binary running this runner

const UNIT_SCRIPT = path.join(__dirname, 'stealth.test.js');

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
function runNode(script, { env = process.env, inherit = false } = {}) {
  const result = spawnSync(NODE, [script], {
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

function modeUnit() {
  console.log('=== [unit] tests/stealth.test.js ===\n');
  const r = runNode(UNIT_SCRIPT, { inherit: true });
  if (r.error) {
    console.error(`Failed to start unit suite: ${r.error.message}`);
    return 1;
  }
  return r.status === null ? 1 : r.status; // pass the suite's exit code through
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
    rows.push({ tz, r, elapsed });
    console.log(r.ok ? `PASS (${elapsed} ms)` : 'FAIL');
    if (!r.ok) {
      // Surface the failing run's captured output for debugging.
      if (r.error) console.error(`  spawn error: ${r.error.message}`);
      if (r.stdout) process.stdout.write(r.stdout);
      if (r.stderr) process.stderr.write(r.stderr);
    }
  }

  console.log(`\nTZ Summary (unit suite):`);
  console.log(`  ${'TZ'.padEnd(width)} | Result | Duration`);
  console.log(`  ${'-'.repeat(width)}-+--------+---------`);
  for (const { tz, r, elapsed } of rows) {
    console.log(`  ${tz.padEnd(width)} | ${(r.ok ? 'PASS' : 'FAIL').padEnd(6)} | ${elapsed} ms`);
  }
  return rows.every(({ r }) => r.ok) ? 0 : 1;
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
  console.log(`Bocchi Privacy Shield - unified test runner

Usage:
  node tests/run_all.js <mode>

Modes:
  unit     Run the unit suite (tests/stealth.test.js) once, with stdio
           inherited; the suite's exit code is passed through.
  tz       Run the unit suite once per timezone in the portability matrix
           (${TZ_MATRIX.join(', ')}) and print a summary table
           (TZ | result | duration). Exits 1 if any timezone fails.
  live     Run the live browser scripts sequentially, in this order:
           ${LIVE_SCRIPTS.join(' -> ')}
           stdio is inherited and CHROME_BIN is passed through from the
           environment. Exits 1 if any script fails. Nothing runs in
           parallel: the browser is heavy and apivoid is rate-limited.
  headed   Same as live, but every script is launched with HEADED=1
           (visible browser windows).
  all      unit -> tz -> live, in that order.
           Exits 1 if any stage failed.

Environment (live/headed modes):
  CHROME_BIN  Path to the Chrome/Chromium binary for the live scripts.
  HEADED=1    Force a visible browser (set automatically by the headed mode).
`);
}

/* ------------------------------------------------------------------- main */

const MODES = {
  unit: modeUnit,
  tz: modeTz,
  live: () => modeLive(false),
  headed: () => modeLive(true),
  all: modeAll,
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
