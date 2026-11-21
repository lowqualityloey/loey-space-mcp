import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs/promises';
import os from 'node:os';
import {spawn, spawnSync} from 'node:child_process';
import {once} from 'node:events';
import {fileURLToPath} from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HOOK_SOURCE = path.resolve(__dirname, '../hooks/post-commit');

// Coordination is the half of this hook the queue tests cannot see: the lock that serialises
// invocations, the rule that decides when a lock may be stolen, the bound that stops a hung
// writer, and the ledger that stops a rebase from stacking entries. These tests drive the real
// hook body in a throwaway repository and assert on the files it leaves behind, because every one
// of these behaviours is only observable as state — a lock that was not released, a capture file
// that outlived its run, a second entry that should never have been written.

function vaultStamp(deltaMinutes) {
  const at = new Date(Date.now() + deltaMinutes * 60 * 1000);
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Pacific/Auckland',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
  }).formatToParts(at).reduce((acc, part) => ({...acc, [part.type]: part.value}), {});
  return {day: parts.year + '-' + parts.month + '-' + parts.day, time: parts.hour + ':' + parts.minute};
}

async function makeRepo(prefix, options) {
  const settings = options || {};
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  spawnSync('git', ['init', '-q'], {cwd: root});
  spawnSync('git', ['config', 'user.email', 'coord-test@example.com'], {cwd: root});
  spawnSync('git', ['config', 'user.name', 'Coord Test'], {cwd: root});
  await fs.rm(path.join(root, '.git/hooks/post-commit'), {force: true});

  const vault = path.join(root, 'vault');
  await fs.mkdir(path.join(vault, '01-Daily'), {recursive: true});
  await fs.writeFile(path.join(vault, 'handoff.md'), '---\ntype: handoff\n---\n# Handoff\n\n### Latest Updates\n');

  const today = vaultStamp(0).day;
  const noteDir = path.join(vault, '01-Daily', today.slice(0, 7));
  await fs.mkdir(noteDir, {recursive: true});
  const notePath = path.join(noteDir, today + '.md');
  await fs.writeFile(notePath, '---\ntype: daily\n---\n# Day\n\n## \u{1F4DD} Daily Log\n');

  const binDir = path.join(root, 'fake-bin');
  await fs.mkdir(binDir, {recursive: true});
  // One argv line per call, so a test can prove the writer ran exactly once.
  const body = settings.fake || '#!/usr/bin/env bash\nprintf \'%s\n\' "$*" >> "$LOEY_TEST_CAPTURE"\nexit 0\n';
  const fake = path.join(binDir, 'heyloey');
  await fs.writeFile(fake, body, {mode: 0o755});

  return {root, vault, binDir, capture: path.join(root, 'capture.txt'), notePath, today};
}

function gitCommit(root, message) {
  return spawnSync('git', ['commit', '--allow-empty', '-q', '-m', message], {cwd: root, encoding: 'utf8'});
}

async function runHook(ctx, env) {
  return spawnSync('bash', [HOOK_SOURCE], {
    cwd: ctx.root,
    encoding: 'utf8',
    env: {
      ...process.env,
      HOME: ctx.root,
      PATH: ctx.binDir + ':' + process.env.PATH,
      LOEY_SPACE_DIR: ctx.vault,
      LOEY_HOOK_OS: 'unix',
      LOEY_TEST_CAPTURE: ctx.capture,
      ...(env || {})
    }
  });
}

/** A pid that is certainly not running: a child that has exited and been reaped. */
async function deadPid() {
  const child = spawn(process.execPath, ['-e', '']);
  const [code] = await once(child, 'exit');
  assert.equal(code, 0);
  return child.pid;
}

async function writeLock(ctx, {pid, at, writer}) {
  const lockDir = path.join(ctx.root, '.git/heyloey-milestones.lock');
  await fs.mkdir(lockDir, {recursive: true});
  await fs.writeFile(path.join(lockDir, 'pid'), String(pid) + '\n');
  await fs.writeFile(path.join(lockDir, 'at'), String(at) + '\n');
  if (writer !== undefined) await fs.writeFile(path.join(lockDir, 'logger'), writer + '\n');
  return lockDir;
}

async function readIfPresent(file) {
  try {
    return await fs.readFile(file, 'utf8');
  } catch {
    return '';
  }
}

/** The hook's own scratch files in .git; the durable run log is not one of them. */
async function strayFiles(ctx) {
  const names = await fs.readdir(path.join(ctx.root, '.git'));
  return names.filter((name) => name.startsWith('heyloey-postcommit'));
}

test('a live lock makes the invocation stand down instead of writing', async () => {
  const ctx = await makeRepo('loey-coord-busy-');
  try {
    gitCommit(ctx.root, 'feat: thing\n\nHeyLoey-Milestone: busy probe');
    const lockDir = await writeLock(ctx, {pid: process.pid, at: Math.floor(Date.now() / 1000), writer: 'none'});
    const before = await fs.readFile(ctx.notePath, 'utf8');

    const result = await runHook(ctx);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stderr, /already logging to this vault/, 'the operator is told why nothing happened');
    assert.equal(await fs.readFile(ctx.notePath, 'utf8'), before, 'a held lock must prevent any write');
    assert.equal(await readIfPresent(ctx.capture), '', 'the writer must never be started');
    assert.ok(await fs.stat(lockDir).then(() => true, () => false), 'a lock this invocation never took must survive');
  } finally {
    await fs.rm(ctx.root, {recursive: true, force: true});
  }
});

test('a lock whose hook and writer are both gone is reclaimed and the run proceeds', async () => {
  const ctx = await makeRepo('loey-coord-reclaim-');
  try {
    gitCommit(ctx.root, 'feat: thing\n\nHeyLoey-Milestone: reclaim probe');
    const lockDir = await writeLock(ctx, {pid: await deadPid(), at: Math.floor(Date.now() / 1000) - 900, writer: 'none'});

    const result = await runHook(ctx);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stderr, /reclaimed a stale coordination lock/, 'the reclaim is reported, never silent');
    assert.match(await readIfPresent(ctx.capture), /done/, 'the milestone is logged after the reclaim');
    assert.ok(!(await fs.stat(lockDir).then(() => true, () => false)), 'the reclaimed lock must be gone');
  } finally {
    await fs.rm(ctx.root, {recursive: true, force: true});
  }
});

test('a lock left by a killed hook whose writer may still run is not stolen', async () => {
  const ctx = await makeRepo('loey-coord-pending-');
  try {
    gitCommit(ctx.root, 'feat: thing\n\nHeyLoey-Milestone: unaccounted writer probe');
    // 'pending' is the record written between the fork and the pid: a writer may exist, so a
    // reclaimer cannot prove the vault is free and must not touch it.
    const lockDir = await writeLock(ctx, {pid: await deadPid(), at: Math.floor(Date.now() / 1000) - 900, writer: 'pending'});
    const before = await fs.readFile(ctx.notePath, 'utf8');

    const result = await runHook(ctx);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stderr, /cannot be reclaimed safely/, 'the refusal explains itself');
    assert.match(result.stderr, /unaccounted for/, 'and names the record that blocks the reclaim');
    assert.equal(await fs.readFile(ctx.notePath, 'utf8'), before);
    assert.ok(await fs.stat(lockDir).then(() => true, () => false), 'an unaccountable lock stays put');
  } finally {
    await fs.rm(ctx.root, {recursive: true, force: true});
  }
});

test('a live writer from a killed hook is reported rather than overwritten', async () => {
  const ctx = await makeRepo('loey-coord-livewriter-');
  try {
    gitCommit(ctx.root, 'feat: thing\n\nHeyLoey-Milestone: live writer probe');
    const lockDir = await writeLock(ctx, {pid: await deadPid(), at: Math.floor(Date.now() / 1000) - 900, writer: String(process.pid)});

    const result = await runHook(ctx);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stderr, /writer \(pid \d+\) from a killed hook is still running/, 'the live writer is named');
    assert.equal(await readIfPresent(ctx.capture), '', 'nothing may be written while a writer may be alive');
    assert.ok(await fs.stat(lockDir).then(() => true, () => false));
  } finally {
    await fs.rm(ctx.root, {recursive: true, force: true});
  }
});

test('a logger that ignores TERM is killed at the bound, and leaves nothing behind', async () => {
  const ctx = await makeRepo('loey-coord-bound-', {
    // 'trap' sets SIG_IGN, which survives exec: the sleep below cannot be ended with TERM.
    fake: '#!/usr/bin/env bash\ntrap \'\' TERM\nprintf \'%s\n\' "$$" > "$LOEY_TEST_PIDFILE"\nexec sleep 30\n'
  });
  try {
    spawnSync('git', ['config', '--local', 'heyloey.timeout', '1'], {cwd: ctx.root});
    gitCommit(ctx.root, 'feat: hang\n\nHeyLoey-Milestone: bounded probe');
    const pidFile = path.join(ctx.root, 'logger.pid');
    const before = await fs.readFile(ctx.notePath, 'utf8');

    const started = Date.now();
    const result = await runHook(ctx, {LOEY_TEST_PIDFILE: pidFile});
    const elapsed = Date.now() - started;

    assert.equal(result.status, 0, 'the commit itself is never affected');
    assert.ok(elapsed >= 1000, 'the bound must actually elapse, took ' + elapsed + 'ms');
    assert.ok(elapsed < 8000, 'the bound must hold near timeout plus grace, took ' + elapsed + 'ms');
    assert.match(result.stderr, /milestone not logged \(logger exit 124\)/);
    assert.equal(await fs.readFile(ctx.notePath, 'utf8'), before, 'a killed logger writes nothing');

    const pid = Number((await fs.readFile(pidFile, 'utf8')).trim());
    assert.ok(!isAlive(pid), 'the logger must not survive the bound');
    assert.ok(!(await fs.stat(path.join(ctx.root, '.git/heyloey-milestones.lock')).then(() => true, () => false)), 'the lock must be released');
    assert.deepEqual(await strayFiles(ctx), [], 'the capture file must not be left behind');
  } finally {
    await fs.rm(ctx.root, {recursive: true, force: true});
  }
});

test('HEYLOEY_LOG=off and heyloey.log=false both disable the hook silently', async () => {
  const ctx = await makeRepo('loey-coord-optout-');
  try {
    gitCommit(ctx.root, 'feat: thing\n\nHeyLoey-Milestone: opt-out probe');
    const before = await fs.readFile(ctx.notePath, 'utf8');

    const byEnv = await runHook(ctx, {HEYLOEY_LOG: 'off'});
    assert.equal(byEnv.status, 0, byEnv.stderr);
    assert.equal(byEnv.stderr.trim(), '', 'an explicit opt-out is not worth a message');

    spawnSync('git', ['config', '--local', 'heyloey.log', 'false'], {cwd: ctx.root});
    const byConfig = await runHook(ctx);
    assert.equal(byConfig.status, 0, byConfig.stderr);
    assert.equal(byConfig.stderr.trim(), '');

    assert.equal(await fs.readFile(ctx.notePath, 'utf8'), before, 'both switches must prevent any write');
    assert.equal(await readIfPresent(ctx.capture), '', 'the writer must never be started');
  } finally {
    await fs.rm(ctx.root, {recursive: true, force: true});
  }
});

test('the ledger admits a key once, and a repeat summary is not written twice', async () => {
  const ctx = await makeRepo('loey-coord-ledger-');
  try {
    const message = 'fix: ledger\n\nHeyLoey-Milestone: settle the ledger ordering';
    gitCommit(ctx.root, message);

    const first = await runHook(ctx);
    assert.equal(first.status, 0, first.stderr);
    assert.match(first.stderr, /logged milestone/);
    assert.equal((await readIfPresent(ctx.capture)).trim().split('\n').length, 1, 'the writer ran once');

    const ledger = await readIfPresent(path.join(ctx.root, '.git/heyloey-milestones'));
    const keys = ledger.split('\n').filter(Boolean);
    assert.equal(keys.length, 1, 'a successful run records exactly one key');
    assert.match(keys[0], /^[0-9a-f]{40}$/, 'the key is a git object id, not a fingerprint of the note');
    assert.ok(!ledger.includes('settle the ledger ordering'), 'the ledger carries no summary text');

    const second = await runHook(ctx);
    assert.equal(second.status, 0, second.stderr);
    assert.match(second.stderr, /already logged today/, 'a repeat is reported, not silently dropped');
    assert.equal((await readIfPresent(ctx.capture)).trim().split('\n').length, 1, 'the writer must not run again');
    assert.equal((await readIfPresent(path.join(ctx.root, '.git/heyloey-milestones'))).split('\n').filter(Boolean).length, 1);
  } finally {
    await fs.rm(ctx.root, {recursive: true, force: true});
  }
});

test('a successful run empties the queue and leaves no scratch file', async () => {
  const ctx = await makeRepo('loey-coord-clean-');
  try {
    gitCommit(ctx.root, 'feat: thing\n\nHeyLoey-Milestone: clean probe');
    const queuePath = path.join(ctx.root, '.git/heyloey-milestones.pending');
    await fs.writeFile(queuePath, '');

    const result = await runHook(ctx);
    assert.equal(result.status, 0, result.stderr);
    assert.equal((await readIfPresent(queuePath)).trim(), '', 'the live record is removed on success');
    assert.deepEqual(await strayFiles(ctx), [], 'no capture file survives a successful run');
    assert.ok(!(await fs.stat(path.join(ctx.root, '.git/heyloey-milestones.lock')).then(() => true, () => false)));
  } finally {
    await fs.rm(ctx.root, {recursive: true, force: true});
  }
});

test('a failing writer keeps its record queued for the next commit', async () => {
  const ctx = await makeRepo('loey-coord-requeue-', {
    fake: '#!/usr/bin/env bash\nprintf \'%s\n\' "$*" >> "$LOEY_TEST_CAPTURE"\nexit 6\n'
  });
  try {
    gitCommit(ctx.root, 'feat: thing\n\nHeyLoey-Milestone: retry probe');
    const queuePath = path.join(ctx.root, '.git/heyloey-milestones.pending');
    await fs.writeFile(queuePath, '');

    const result = await runHook(ctx);
    assert.equal(result.status, 0, 'the commit is never failed by the logger');
    assert.match(result.stderr, /milestone not logged \(logger exit 6\)/);
    const queued = (await readIfPresent(queuePath)).trim().split('\n').filter(Boolean);
    assert.equal(queued.length, 1, 'a failed write stays queued');
    assert.equal(queued[0].split('\t').length, 3, 'the record keeps its UTC stamp, vault stamp and summary');
    assert.equal(queued[0].split('\t')[2], 'retry probe');
    assert.ok(!(await fs.stat(path.join(ctx.root, '.git/heyloey-milestones.lock')).then(() => true, () => false)), 'the lock is released on failure too');
  } finally {
    await fs.rm(ctx.root, {recursive: true, force: true});
  }
});

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
