import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs/promises';
import os from 'node:os';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CANONICAL_CLI = path.resolve(__dirname, '../canonical/heyloey.cjs');

function git(cwd, args, env = process.env) {
  return spawnSync('git', args, {cwd, env, encoding: 'utf8'});
}

async function makeRepo(prefix) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  git(root, ['init', '-q']);
  git(root, ['config', 'user.email', 'hook-test@example.com']);
  git(root, ['config', 'user.name', 'Hook Test']);
  await fs.mkdir(path.join(root, 'vault'), {recursive: true});
  // A user-level init template can ship an active post-commit hook; start from a clean slate
  // so each test controls exactly which hook exists.
  await fs.rm(path.join(root, '.git/hooks/post-commit'), {force: true});
  return root;
}

function installHook(root, extraArgs = []) {
  return spawnSync(process.execPath, [CANONICAL_CLI, 'install-hook', ...extraArgs], {
    cwd: root,
    encoding: 'utf8',
    env: {...process.env, LOEY_SPACE_DIR: path.join(root, 'vault')}
  });
}

async function makeFakeCli(binDir) {
  await fs.mkdir(binDir, {recursive: true});
  const file = path.join(binDir, 'heyloey');
  await fs.writeFile(file, "#!/usr/bin/env bash\nprintf '%s\\n' \"$*\" >> \"$LOEY_TEST_CAPTURE\"\n", {mode: 0o755});
}

function commit(root, message, binDir, capture) {
  return spawnSync('git', ['commit', '--allow-empty', '-q', '-m', message], {
    cwd: root,
    encoding: 'utf8',
    env: {...process.env, PATH: `${binDir}:${process.env.PATH}`, LOEY_TEST_CAPTURE: capture}
  });
}

test('install-hook writes a trailer-gated hook and never logs a plain commit', async () => {
  const root = await makeRepo('loey-hook-plain-');
  const binDir = path.join(root, 'fake-bin');
  const capture = path.join(root, 'capture.txt');
  try {
    const installed = installHook(root);
    assert.equal(installed.status, 0, installed.stderr);

    const hook = await fs.readFile(path.join(root, '.git/hooks/post-commit'), 'utf8');
    assert.match(hook, /# heyloey-managed/);
    assert.match(hook, /HeyLoey-Milestone:/);
    assert.ok(!/heyloey log/.test(hook), 'the old unconditional logger must be gone');
    assert.match(hook, /heyloey done/);

    await makeFakeCli(binDir);

    let result = commit(root, 'plain commit', binDir, capture);
    assert.equal(result.status, 0, result.stderr);
    await assert.rejects(() => fs.stat(capture), 'a plain commit must not invoke the logger');

    result = commit(root, 'chore: empty trailer\n\nHeyLoey-Milestone:   ', binDir, capture);
    assert.equal(result.status, 0, result.stderr);
    await assert.rejects(() => fs.stat(capture), 'an empty trailer is not an opt-in');

    result = commit(root, 'feat: something\n\nHeyLoey-Milestone: shipped the feature', binDir, capture);
    assert.equal(result.status, 0, result.stderr);
    const logged = await fs.readFile(capture, 'utf8');
    assert.match(logged, /^done shipped the feature$/m);
  } finally {
    await fs.rm(root, {recursive: true, force: true});
  }
});

test('install-hook refuses a foreign hook and backs it up only under --force', async () => {
  const root = await makeRepo('loey-hook-foreign-');
  try {
    const hookPath = path.join(root, '.git/hooks/post-commit');
    const foreign = '#!/usr/bin/env bash\nexit 0\n';
    await fs.mkdir(path.dirname(hookPath), {recursive: true});
    await fs.writeFile(hookPath, foreign, {mode: 0o755});

    const refused = installHook(root);
    assert.equal(refused.status, 1);
    assert.match(refused.stdout + refused.stderr, /REFUSED install-hook/);
    assert.equal(await fs.readFile(hookPath, 'utf8'), foreign, 'a refused install changes nothing');

    const forced = installHook(root, ['--force']);
    assert.equal(forced.status, 0, forced.stderr);
    const backups = (await fs.readdir(path.dirname(hookPath))).filter((name) => name.startsWith('post-commit.bak-'));
    assert.equal(backups.length, 1, '--force keeps exactly one timestamped backup');
    assert.equal(await fs.readFile(path.join(path.dirname(hookPath), backups[0]), 'utf8'), foreign);
    assert.match(await fs.readFile(hookPath, 'utf8'), /# heyloey-managed/);

    const reinstall = installHook(root);
    assert.equal(reinstall.status, 0, reinstall.stderr);
    const after = (await fs.readdir(path.dirname(hookPath))).filter((name) => name.startsWith('post-commit.bak-'));
    assert.equal(after.length, 1, 're-installing a managed hook must not create another backup');
  } finally {
    await fs.rm(root, {recursive: true, force: true});
  }
});

test('install-hook honours core.hooksPath instead of .git/hooks', async () => {
  const root = await makeRepo('loey-hook-path-');
  try {
    git(root, ['config', 'core.hooksPath', '.githooks']);
    const installed = installHook(root);
    assert.equal(installed.status, 0, installed.stderr);

    const hook = await fs.readFile(path.join(root, '.githooks/post-commit'), 'utf8');
    assert.match(hook, /# heyloey-managed/);
    await assert.rejects(() => fs.stat(path.join(root, '.git/hooks/post-commit')));
  } finally {
    await fs.rm(root, {recursive: true, force: true});
  }
});
