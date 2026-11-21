import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {createMockVault} from './helpers/mock-vault.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CANONICAL_CLI = path.resolve(__dirname, '../canonical/heyloey.cjs');

function envFor(vault, logPath) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('LOEY_')));
  env.LOEY_SPACE_DIR = vault.root;
  env.LOEY_LOCK_DIR = path.join(vault.root, '.locks');
  env.LOEY_RECONCILE_LOG = logPath;
  return env;
}

function brief(vault, logPath) {
  return spawnSync(process.execPath, [CANONICAL_CLI, 'brief'], {encoding: 'utf8', env: envFor(vault, logPath)});
}

function alertsOf(stdout) {
  const lines = stdout.split('\n');
  const at = lines.indexOf('[MAINTENANCE ALERTS]');
  if (at === -1) return [];
  return lines.slice(at + 1).filter((line) => line.startsWith('- ')).map((line) => line.slice(2));
}

function reconcilerAlerts(stdout) {
  return alertsOf(stdout).filter((line) => line.includes('RECONCILER:'));
}

// A vault declares the integration by holding this allowlist; without it there is nothing to report on.
async function optIn(vault) {
  await fs.writeFile(path.join(vault.root, '.github-milestone-repositories.json'), '{"repositories":["lowqualityloey/promptkit-os"]}\n');
}

/**
 * The alert must consume the vault's own reconciler verdict, never re-derive it, so the fixture
 * supplies that module with a verdict the test chooses. If the CLI ever started computing drift
 * itself, these tests would still pass while the two answers silently diverged - so the stub
 * records that it was asked.
 */
async function stubReconciler(vault, report, logPath) {
  const modulePath = path.join(vault.root, '06-Resources', 'scripts', 'reconcile-github-milestones.mjs');
  const asked = path.join(vault.root, 'stub-asked.json');
  const body = [
    "import fs from 'node:fs';",
    'export function readinessReport() {',
    '  fs.writeFileSync(' + JSON.stringify(asked) + ", JSON.stringify({asked: true}));",
    '  return ' + JSON.stringify(report) + ';',
    '}',
    'export function reconcileLogPath() { return ' + JSON.stringify(logPath) + '; }',
    ''
  ].join('\n');
  await fs.writeFile(modulePath, body);
  return asked;
}

async function logFile(vault, lines) {
  const dir = path.join(vault.root, 'state');
  await fs.mkdir(dir, {recursive: true});
  const file = path.join(dir, 'reconcile.log');
  await fs.writeFile(file, lines.map((line) => line + '\n').join(''));
  return file;
}

const HEALTHY = 'RESULT reconcile unchanged logged=0 already-recorded=7 milestones-verified=7 lock=flock target=/vault';

test('a healthy tick produces no reconciler alert at all', async () => {
  const vault = await createMockVault('loey-recon-healthy-');
  try {
    await optIn(vault);
    const file = await logFile(vault, [HEALTHY]);
    await stubReconciler(vault, {ready: true, state: 'ok', drifted: [], missing: [], onlyInReceipt: []}, file);
    const result = brief(vault, file);
    assert.equal(result.status, 0, result.stderr + result.stdout);
    assert.deepEqual(reconcilerAlerts(result.stdout), [], 'health must be silent, not a green line');
  } finally {
    await vault.cleanup();
  }
});

test('an unclean newest RESULT is reported with its reason', async () => {
  const vault = await createMockVault('loey-recon-failed-');
  try {
    await optIn(vault);
    const file = await logFile(vault, [
      HEALTHY,
      'RESULT reconcile failed: Post-write verification failed for https://github.com/o/r/pull/1. (checkpoint not advanced past unverified work).'
    ]);
    await stubReconciler(vault, {ready: true, state: 'ok', drifted: [], missing: [], onlyInReceipt: []}, file);
    const result = brief(vault, file);
    const alerts = reconcilerAlerts(result.stdout);
    assert.equal(alerts.length, 1, result.stdout);
    assert.match(alerts[0], /last run did not finish cleanly - failed: Post-write verification failed/);
  } finally {
    await vault.cleanup();
  }
});

test('a lock refusal counts as unfinished work, not as success', async () => {
  const vault = await createMockVault('loey-recon-lock-');
  try {
    await optIn(vault);
    const file = await logFile(vault, ['RESULT reconcile lock-contended; nothing was written by this run.']);
    await stubReconciler(vault, {ready: true, state: 'ok', drifted: [], missing: [], onlyInReceipt: []}, file);
    const result = brief(vault, file);
    const alerts = reconcilerAlerts(result.stdout);
    assert.equal(alerts.length, 1, result.stdout);
    assert.match(alerts[0], /last run did not finish cleanly - lock-contended/);
  } finally {
    await vault.cleanup();
  }
});

test('a log with no RESULT line reports that the tick never completed', async () => {
  const vault = await createMockVault('loey-recon-noresult-');
  try {
    await optIn(vault);
    const file = await logFile(vault, ['Fetching merged pull requests...', 'gathering history']);
    await stubReconciler(vault, {ready: true, state: 'ok', drifted: [], missing: [], onlyInReceipt: []}, file);
    const result = brief(vault, file);
    const alerts = reconcilerAlerts(result.stdout);
    assert.equal(alerts.length, 1, result.stdout);
    assert.match(alerts[0], /holds no RESULT line - the tick never completed/);
  } finally {
    await vault.cleanup();
  }
});

test('a missing log reports no run recorded yet and names the file', async () => {
  const vault = await createMockVault('loey-recon-nolog-');
  try {
    await optIn(vault);
    const file = path.join(vault.root, 'state', 'absent.log');
    await stubReconciler(vault, {ready: true, state: 'ok', drifted: [], missing: [], onlyInReceipt: []}, file);
    const result = brief(vault, file);
    const alerts = reconcilerAlerts(result.stdout);
    assert.equal(alerts.length, 1, result.stdout);
    assert.match(alerts[0], /no run recorded yet \(.*absent\.log\) - check "crontab -l"/);
  } finally {
    await vault.cleanup();
  }
});

test('a clean tick older than two hours is reported as stale', async () => {
  const vault = await createMockVault('loey-recon-stale-');
  try {
    await optIn(vault);
    const file = await logFile(vault, [HEALTHY]);
    await stubReconciler(vault, {ready: true, state: 'ok', drifted: [], missing: [], onlyInReceipt: []}, file);
    const old = new Date(Date.now() - 3.5 * 60 * 60 * 1000);
    await fs.utimes(file, old, old);
    const result = brief(vault, file);
    const alerts = reconcilerAlerts(result.stdout);
    assert.equal(alerts.length, 1, result.stdout);
    assert.match(alerts[0], /no run for 3\.5h \(hourly cron expected; .*reconcile\.log\)/);
  } finally {
    await vault.cleanup();
  }
});

test('a failure is reported as a failure, never also as stale', async () => {
  const vault = await createMockVault('loey-recon-onealert-');
  try {
    await optIn(vault);
    const file = await logFile(vault, ['RESULT reconcile failed: boom (checkpoint not advanced past unverified work).']);
    await stubReconciler(vault, {ready: true, state: 'ok', drifted: [], missing: [], onlyInReceipt: []}, file);
    const old = new Date(Date.now() - 9 * 60 * 60 * 1000);
    await fs.utimes(file, old, old);
    const result = brief(vault, file);
    const alerts = reconcilerAlerts(result.stdout);
    assert.equal(alerts.length, 1, 'one alert per condition, so the reason is never buried: ' + result.stdout);
    assert.match(alerts[0], /did not finish cleanly/);
  } finally {
    await vault.cleanup();
  }
});

test('a drifted receipt is named and points at --enable', async () => {
  const vault = await createMockVault('loey-recon-drift-');
  try {
    await optIn(vault);
    const file = await logFile(vault, [HEALTHY]);
    const asked = await stubReconciler(vault, {
      ready: false,
      state: 'drift',
      drifted: ['06-Resources/scripts/reconcile-github-milestones.mjs', '.githooks/post-commit', 'a-third.mjs'],
      missing: [],
      onlyInReceipt: []
    }, file);
    const result = brief(vault, file);
    const alerts = reconcilerAlerts(result.stdout);
    assert.equal(alerts.length, 1, result.stdout);
    assert.match(alerts[0], /source verification drift - 06-Resources\/scripts\/reconcile-github-milestones\.mjs, \.githooks\/post-commit \(\+1 more\); the next commit refuses until "npm run reconcile-github -- --enable"/);
    assert.ok(await fs.stat(asked), 'the alert must ask the vault reconciler for its verdict');
  } finally {
    await vault.cleanup();
  }
});

test('a vault that declares no repositories stays silent about the reconciler', async () => {
  const vault = await createMockVault('loey-recon-optout-');
  try {
    const file = await logFile(vault, ['RESULT reconcile failed: boom']);
    const result = brief(vault, file);
    assert.deepEqual(reconcilerAlerts(result.stdout), [], 'not opted in is configuration, not rot');
  } finally {
    await vault.cleanup();
  }
});

test('a vault with no reconciler module is not reported as drift', async () => {
  const vault = await createMockVault('loey-recon-nomodule-');
  try {
    await optIn(vault);
    const file = await logFile(vault, [HEALTHY]);
    const result = brief(vault, file);
    assert.equal(result.status, 0, result.stderr + result.stdout);
    assert.deepEqual(reconcilerAlerts(result.stdout), [], 'an older vault cannot be compared, so it must not be accused');
  } finally {
    await vault.cleanup();
  }
});
