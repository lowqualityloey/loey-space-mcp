import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs/promises';
import os from 'node:os';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HOOK_SOURCE = path.resolve(__dirname, '../hooks/post-commit');

// The pending queue is the hook's last-resort guarantee: a milestone that could not
// be written is replayed by a later commit. These tests drive the real hook body
// against a fake CLI and assert on the exact argv it receives, because a replay that
// silently drops its --date looks identical to a successful one on stderr.

function vaultStamp(deltaMinutes) {
  const at = new Date(Date.now() + deltaMinutes * 60 * 1000);
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Pacific/Auckland',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
  }).formatToParts(at).reduce((acc, part) => ({...acc, [part.type]: part.value}), {});
  return {day: parts.year + '-' + parts.month + '-' + parts.day, time: parts.hour + ':' + parts.minute};
}

async function makeRepo(prefix) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  spawnSync('git', ['init', '-q'], {cwd: root});
  spawnSync('git', ['config', 'user.email', 'queue-test@example.com'], {cwd: root});
  spawnSync('git', ['config', 'user.name', 'Queue Test'], {cwd: root});
  await fs.rm(path.join(root, '.git/hooks/post-commit'), {force: true});

  const vault = path.join(root, 'vault');
  await fs.mkdir(path.join(vault, '01-Daily'), {recursive: true});
  await fs.writeFile(path.join(vault, 'handoff.md'), '---\ntype: handoff\n---\n# Handoff\n\n### Latest Updates\n');

  const binDir = path.join(root, 'fake-bin');
  await fs.mkdir(binDir, {recursive: true});
  // Records one argv line per call, so the test can assert on flags, not formatting.
  const fake = path.join(binDir, 'heyloey');
  await fs.writeFile(fake, '#!/usr/bin/env bash\nprintf \'%s\\n\' "$*" >> "$LOEY_TEST_CAPTURE"\nexit "${LOEY_TEST_EXIT:-0}"\n', {mode: 0o755});

  return {root, vault, binDir, capture: path.join(root, 'capture.txt')};
}

async function runHook(ctx, options) {
  const settings = options || {};
  const queuePath = path.join(ctx.root, '.git', 'heyloey-milestones.pending');
  await fs.writeFile(queuePath, settings.queue || '');

  const today = vaultStamp(0).day;
  const noteDir = path.join(ctx.vault, '01-Daily', today.slice(0, 7));
  await fs.mkdir(noteDir, {recursive: true});
  const notePath = path.join(noteDir, today + '.md');
  if (settings.writable !== false) {
    await fs.writeFile(notePath, '---\ntype: daily\n---\n# Day\n\n## \u{1F4DD} Daily Log\n');
  }

  if (settings.readonly) {
    await fs.chmod(notePath, 0o444);
    await fs.chmod(noteDir, 0o555);
    await fs.chmod(path.join(ctx.vault, 'handoff.md'), 0o444);
  }

  const env = {
    ...process.env,
    HOME: ctx.root,
    PATH: ctx.binDir + ':' + process.env.PATH,
    LOEY_SPACE_DIR: ctx.vault,
    LOEY_HOOK_OS: settings.hookOs || 'unix',
    LOEY_TEST_CAPTURE: ctx.capture,
    LOEY_TEST_EXIT: settings.exitCode || '0'
  };
  if (settings.omitVaultEnv) delete env.LOEY_SPACE_DIR;
  Object.assign(env, settings.env || {});

  const result = spawnSync('bash', [HOOK_SOURCE], {
    cwd: ctx.root,
    encoding: 'utf8',
    env
  });
  return {result, queuePath, notePath};
}

// A read-only probe leaves the tree unwritable, so cleanup has to put the
// permissions back before the temp directory can be removed.
async function restorePermissions(ctx) {
  const today = vaultStamp(0).day;
  const noteDir = path.join(ctx.vault, '01-Daily', today.slice(0, 7));
  await fs.chmod(path.join(ctx.vault, 'handoff.md'), 0o644).catch(() => {});
  await fs.chmod(noteDir, 0o755).catch(() => {});
  await fs.chmod(path.join(noteDir, today + '.md'), 0o644).catch(() => {});
}

function gitCommit(root, message) {
  return spawnSync('git', ['commit', '--allow-empty', '-q', '-m', message], {cwd: root, encoding: 'utf8'});
}

async function writeDayNote(vault, day, body) {
  const dir = path.join(vault, '01-Daily', day.slice(0, 7));
  await fs.mkdir(dir, {recursive: true});
  await fs.writeFile(path.join(dir, day + '.md'), body);
}

test('a milestone that cannot be written is queued with its vault stamp', async () => {
  const ctx = await makeRepo('loey-queue-stamp-');
  try {
    gitCommit(ctx.root, 'feat: thing\n\nHeyLoey-Milestone: queued milestone body');
    // The records exist but are unwritable: the state a read-only sandbox mount
    // produces, and the only path the pre-flight gate can catch.
    const {result, queuePath} = await runHook(ctx, {readonly: true});
    assert.equal(result.status, 0, result.stderr);

    const fields = (await fs.readFile(queuePath, 'utf8')).trim().split('\t');
    assert.equal(fields.length, 3, 'a record carries UTC stamp, vault stamp and summary');
    assert.match(fields[0], /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
    assert.match(fields[1], /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/, 'the vault stamp is a real timestamp');
    assert.ok(fields[1].startsWith(vaultStamp(0).day), 'the vault stamp is in Pacific/Auckland, matching the note day');
    assert.equal(fields[2], 'queued milestone body');
  } finally {
    await restorePermissions(ctx);
    await fs.rm(ctx.root, {recursive: true, force: true});
  }
});

test('a replay passes the recorded day and time as --date and --time', async () => {
  const ctx = await makeRepo('loey-queue-replay-');
  try {
    const yesterday = vaultStamp(-24 * 60);
    await writeDayNote(ctx.vault, yesterday.day, '---\ntype: daily\n---\n# Day\n\n## \u{1F4DD} Daily Log\n');
    const record = '2026-11-20 10:50\t' + yesterday.day + ' 23:50\tlate night milestone';

    gitCommit(ctx.root, 'chore: writable commit\n\nHeyLoey-Milestone: live milestone');
    const {result, queuePath} = await runHook(ctx, {queue: record + '\n'});
    assert.equal(result.status, 0, result.stderr);

    const argv = await fs.readFile(ctx.capture, 'utf8');
    assert.ok(argv.includes('--date ' + yesterday.day), 'the replay names the day it happened: ' + argv);
    assert.ok(argv.includes('--time 23:50'), 'the replay keeps the recorded time: ' + argv);
    assert.ok(argv.includes('late night milestone'), 'the replayed summary survives');
    assert.equal((await fs.readFile(queuePath, 'utf8')).trim(), '', 'a clean replay empties the record');
  } finally {
    await fs.rm(ctx.root, {recursive: true, force: true});
  }
});

test('a two-field legacy record still replays, keeping its literal prefix', async () => {
  const ctx = await makeRepo('loey-queue-legacy-');
  try {
    const legacy = '2026-11-20 10:50\tlegacy milestone from before the vault stamp';
    gitCommit(ctx.root, 'chore: writable commit\n\nHeyLoey-Milestone: live milestone');
    const {result, queuePath} = await runHook(ctx, {queue: legacy + '\n'});
    assert.equal(result.status, 0, result.stderr);

    const argv = await fs.readFile(ctx.capture, 'utf8');
    assert.ok(argv.includes('legacy milestone from before the vault stamp'));
    assert.ok(!argv.includes('--date'), 'no date is invented for a record that never had one');
    assert.equal((await fs.readFile(queuePath, 'utf8')).trim(), '');
  } finally {
    await fs.rm(ctx.root, {recursive: true, force: true});
  }
});

test('a record already in its own day note is not replayed twice', async () => {
  const ctx = await makeRepo('loey-queue-dedupe-');
  try {
    const earlier = vaultStamp(-2 * 24 * 60);
    await writeDayNote(ctx.vault, earlier.day, '---\ntype: daily\n---\n# Day\n\n## \u{1F4DD} Daily Log\n- already here once: backdated duplicate probe\n');
    const record = '2026-11-20 10:50\t' + earlier.day + ' 09:10\tbackdated duplicate probe';

    gitCommit(ctx.root, 'chore: writable commit\n\nHeyLoey-Milestone: live milestone');
    const {result, queuePath} = await runHook(ctx, {queue: record + '\n'});
    assert.equal(result.status, 0, result.stderr);

    const captured = await fs.stat(ctx.capture).then(() => fs.readFile(ctx.capture, 'utf8'), () => '');
    assert.ok(!captured.includes('backdated duplicate probe'), 'the duplicate must not be replayed: ' + captured);
    assert.equal((await fs.readFile(queuePath, 'utf8')).trim(), '', 'the duplicate is retired, not retried forever');
  } finally {
    await fs.rm(ctx.root, {recursive: true, force: true});
  }
});

test('a failed replay puts the record back with all three fields intact', async () => {
  const ctx = await makeRepo('loey-queue-retry-');
  try {
    const record = '2026-11-20 10:50\t2026-11-19 23:50\tretry me later';
    gitCommit(ctx.root, 'chore: writable commit\n\nHeyLoey-Milestone: live milestone');
    const {result, queuePath} = await runHook(ctx, {queue: record + '\n', exitCode: '6'});
    assert.equal(result.status, 0, 'the commit itself is never affected');
    const lines = (await fs.readFile(queuePath, 'utf8')).trim().split('\n');
    assert.equal(lines[0], record, 'a failed replay is preserved verbatim, in order');
    assert.equal(lines.length, 2, 'the failing live call keeps its own record too');
  } finally {
    await fs.rm(ctx.root, {recursive: true, force: true});
  }
});

test('a legacy record queued for another day is replayed into that day', async () => {
  const ctx = await makeRepo('loey-queue-otherday-');
  try {
    const earlier = vaultStamp(-3 * 24 * 60);
    await writeDayNote(ctx.vault, earlier.day, '---\ntype: daily\n---\n# Day\n\n## \u{1F4DD} Daily Log\n');
    // A tri-field record whose day is NOT today must still be deduped against its own note,
    // otherwise it falls back to today's note, misses, and logs itself again on every commit.
    const record = '2026-11-20 10:50\t' + earlier.day + ' 08:05\talready-present in its own day';
    await writeDayNote(ctx.vault, earlier.day, '---\ntype: daily\n---\n# Day\n\n## \u{1F4DD} Daily Log\n- already-present in its own day\n');

    gitCommit(ctx.root, 'chore: writable commit\n\nHeyLoey-Milestone: live milestone');
    const {result, queuePath} = await runHook(ctx, {queue: record + '\n'});
    assert.equal(result.status, 0, result.stderr);
    assert.equal((await fs.readFile(queuePath, 'utf8')).trim(), '', 'dedupe reads the record day note');
  } finally {
    await fs.rm(ctx.root, {recursive: true, force: true});
  }
});

test('the Windows WSL logger uses heyloey.vault, not the repo root', async () => {
  const ctx = await makeRepo('loey-wsl-vault-');
  try {
    const wslCapture = path.join(ctx.root, 'wsl-capture.txt');
    const wsl = path.join(ctx.binDir, 'wsl.exe');
    await fs.writeFile(wsl, [
      '#!/usr/bin/env bash',
      'printf "%s\n" "$*" >> "${LOEY_TEST_WSL_CAPTURE:-/dev/null}"',
      'case "$*" in',
      '  *"command -v heyloey"*) printf "%s\n" "${LOEY_TEST_WSL_CLI:-/fake/heyloey}" ;;',
      'esac',
      'exit 0',
      ''
    ].join('\n'), {mode: 0o755});

    spawnSync('git', ['config', 'heyloey.vault', ctx.vault], {cwd: ctx.root});
    gitCommit(ctx.root, 'chore: windows dispatch\n\nHeyLoey-Milestone: configured vault routing');
    const {result, queuePath} = await runHook(ctx, {
      hookOs: 'windows',
      omitVaultEnv: true,
      env: {LOEY_TEST_WSL_CAPTURE: wslCapture, LOEY_TEST_WSL_CLI: '/fake/heyloey'}
    });
    assert.equal(result.status, 0, result.stderr);

    const calls = await fs.readFile(wslCapture, 'utf8');
    const logged = calls.split('\n').filter((line) => line.includes(' done '));
    assert.ok(logged.length > 0, 'the hook must invoke the WSL logger: ' + calls);
    assert.ok(logged.some((line) => line.includes('LOEY_SPACE_DIR=' + ctx.vault + ' ')), 'the configured vault must reach the logger: ' + calls);
    assert.ok(!logged.some((line) => line.includes('LOEY_SPACE_DIR=' + ctx.root + ' ')), 'the repo root must not override heyloey.vault: ' + calls);
    assert.equal((await fs.readFile(queuePath, 'utf8')).trim(), '', 'a successful WSL log must not queue');
  } finally {
    await fs.rm(ctx.root, {recursive: true, force: true});
  }
});
