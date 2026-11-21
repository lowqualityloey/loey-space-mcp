import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs/promises';
import os from 'node:os';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const INSTALLER = path.resolve(__dirname, '../tools/install-hook.mjs');
const SOURCE = path.resolve(__dirname, '../hooks/post-commit');

/**
 * tools/install-hook.mjs is the installer that actually ships the union hook into
 * every repository and into the user-level git template. It had no tests, which is
 * how it once overwrote a lefthook dispatcher: --repo resolves through
 * `git rev-parse --git-path hooks`, and for a repository with core.hooksPath set
 * that path is the dispatcher directory, not a hooks directory.
 */
function git(cwd, args) {
  return spawnSync('git', args, {cwd, encoding: 'utf8'});
}

async function makeRepo(prefix) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  git(root, ['init', '-q']);
  git(root, ['config', 'user.email', 'hook-tool@example.com']);
  git(root, ['config', 'user.name', 'Hook Tool']);
  // A user-level template may ship an active hook; start from a clean slate so each
  // test controls exactly which file exists.
  await fs.rm(path.join(root, '.git/hooks/post-commit'), {force: true});
  return root;
}

/** A home directory of its own, so backup paths never touch the real one. */
async function makeHome(prefix) {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

function install(args, home) {
  return spawnSync(process.execPath, [INSTALLER, ...args], {
    encoding: 'utf8',
    env: {...process.env, HOME: home}
  });
}

/** The lefthook dispatcher that a core.hooksPath directory contains. */
const DISPATCHER = '#!/bin/sh\n\ncall_lefthook run "post-commit" "$@"\n';

async function makeLefthookRepo(prefix, {marker = true} = {}) {
  const root = await makeRepo(prefix);
  const dir = path.join(root, '.git/dsh-hooks');
  await fs.mkdir(dir, {recursive: true});
  await fs.writeFile(path.join(dir, 'post-commit'), DISPATCHER, {mode: 0o755});
  if (marker) {
    await fs.writeFile(
      path.join(dir, '.dsh-lefthook-owned'),
      JSON.stringify({version: 1, owner: 'lefthook', hooksPath: dir})
    );
  }
  git(root, ['config', 'core.hooksPath', '.git/dsh-hooks']);
  return {root, dir};
}

test('install-hook.mjs installs the union hook into a plain repository', async () => {
  const root = await makeRepo('hook-tool-plain-');
  const home = await makeHome('hook-tool-home-');
  try {
    const result = install(['--repo', root], home);
    assert.equal(result.status, 0, result.stdout + result.stderr);

    const hookPath = path.join(root, '.git/hooks/post-commit');
    const installed = await fs.readFile(hookPath, 'utf8');
    assert.match(installed, /# Installed by loey-space-mcp tools\/install-hook\.mjs/);
    assert.match(installed, /HeyLoey-Milestone:/);
    assert.ok(!/heyloey log/.test(installed), 'the old unconditional logger must be gone');
    assert.equal((await fs.stat(hookPath)).mode & 0o777, 0o755, 'git skips a non-executable hook');
  } finally {
    await fs.rm(root, {recursive: true, force: true});
    await fs.rm(home, {recursive: true, force: true});
  }
});

test('install-hook.mjs refuses a core.hooksPath dispatcher directory', async () => {
  const {root, dir} = await makeLefthookRepo('hook-tool-dispatcher-');
  const home = await makeHome('hook-tool-home-');
  try {
    const before = await fs.readFile(path.join(dir, 'post-commit'), 'utf8');

    // --force must not help: replacing a dispatcher is not a thing an operator
    // confirms their way past, because the jobs it routed are not recoverable here.
    const result = install(['--repo', root, '--force'], home);
    assert.equal(result.status, 1, 'a dispatcher directory must be refused');
    assert.match(result.stdout + result.stderr, /owned by a hook dispatcher/);

    assert.equal(
      await fs.readFile(path.join(dir, 'post-commit'), 'utf8'),
      before,
      'the dispatcher must be byte-identical after a refused install'
    );
  } finally {
    await fs.rm(root, {recursive: true, force: true});
    await fs.rm(home, {recursive: true, force: true});
  }
});

test('install-hook.mjs recognises a lefthook dispatcher without its marker file', async () => {
  const {root, dir} = await makeLefthookRepo('hook-tool-nomarker-', {marker: false});
  const home = await makeHome('hook-tool-home-');
  try {
    const result = install(['--repo', root], home);
    assert.equal(result.status, 1, 'the dispatcher content alone identifies the directory');
    assert.match(result.stdout + result.stderr, /owned by a hook dispatcher/);
    assert.equal(await fs.readFile(path.join(dir, 'post-commit'), 'utf8'), DISPATCHER);
  } finally {
    await fs.rm(root, {recursive: true, force: true});
    await fs.rm(home, {recursive: true, force: true});
  }
});

test('install-hook.mjs --hooks-dir writes beside a dispatcher and leaves it intact', async () => {
  const {root, dir} = await makeLefthookRepo('hook-tool-hooksdir-');
  const home = await makeHome('hook-tool-home-');
  try {
    const plain = path.join(root, '.git/hooks');
    const result = install(['--hooks-dir', plain], home);
    assert.equal(result.status, 0, result.stdout + result.stderr);

    assert.match(
      await fs.readFile(path.join(plain, 'post-commit'), 'utf8'),
      /# Installed by loey-space-mcp/
    );
    assert.equal(
      await fs.readFile(path.join(dir, 'post-commit'), 'utf8'),
      DISPATCHER,
      'the dispatcher a hook routes through is never the destination'
    );
  } finally {
    await fs.rm(root, {recursive: true, force: true});
    await fs.rm(home, {recursive: true, force: true});
  }
});

test('install-hook.mjs refuses a foreign hook and replaces it only under --force', async () => {
  const root = await makeRepo('hook-tool-foreign-');
  const home = await makeHome('hook-tool-home-');
  try {
    const hookPath = path.join(root, '.git/hooks/post-commit');
    const foreign = '#!/usr/bin/env bash\nexit 0\n';
    await fs.mkdir(path.dirname(hookPath), {recursive: true});
    await fs.writeFile(hookPath, foreign, {mode: 0o755});

    const refused = install(['--repo', root], home);
    assert.equal(refused.status, 1);
    assert.match(refused.stdout + refused.stderr, /REFUSED/);
    assert.equal(await fs.readFile(hookPath, 'utf8'), foreign, 'a refused install changes nothing');

    const forced = install(['--repo', root, '--force'], home);
    assert.equal(forced.status, 0, forced.stdout + forced.stderr);
    assert.match(await fs.readFile(hookPath, 'utf8'), /# Installed by loey-space-mcp/);

    // The backup lives outside the hook directory: git copies every file in a
    // template's hooks/ into each new repository, so a backup beside the hook
    // would be inherited forever.
    const backups = await fs.readdir(path.join(home, '.local/state/heyloey/hook-backups'), {
      recursive: true
    });
    const kept = backups.filter((name) => name.endsWith('post-commit.bak'));
    assert.equal(kept.length, 1, 'exactly one backup is kept per target');
    assert.equal(
      await fs.readFile(
        path.join(home, '.local/state/heyloey/hook-backups', kept[0]),
        'utf8'
      ),
      foreign
    );
  } finally {
    await fs.rm(root, {recursive: true, force: true});
    await fs.rm(home, {recursive: true, force: true});
  }
});

test('install-hook.mjs re-run is idempotent and re-asserts the executable bit', async () => {
  const root = await makeRepo('hook-tool-idempotent-');
  const home = await makeHome('hook-tool-home-');
  try {
    const hookPath = path.join(root, '.git/hooks/post-commit');
    assert.equal(install(['--repo', root], home).status, 0);
    const first = await fs.readFile(hookPath, 'utf8');

    await fs.chmod(hookPath, 0o644);
    const second = install(['--repo', root], home);
    assert.equal(second.status, 0, second.stdout + second.stderr);
    assert.match(second.stdout, /already installed and up to date/);
    assert.equal(await fs.readFile(hookPath, 'utf8'), first, 'a re-run rewrites nothing');
    assert.equal((await fs.stat(hookPath)).mode & 0o777, 0o755, 'the bit is re-asserted');
  } finally {
    await fs.rm(root, {recursive: true, force: true});
    await fs.rm(home, {recursive: true, force: true});
  }
});

test('install-hook.mjs --dry-run reports without writing', async () => {
  const root = await makeRepo('hook-tool-dry-');
  const home = await makeHome('hook-tool-home-');
  try {
    const hookPath = path.join(root, '.git/hooks/post-commit');
    const result = install(['--repo', root, '--dry-run'], home);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /would be created/);
    await assert.rejects(() => fs.stat(hookPath), 'a dry run must write nothing');
  } finally {
    await fs.rm(root, {recursive: true, force: true});
    await fs.rm(home, {recursive: true, force: true});
  }
});

test('install-hook.mjs ships the same hook as the tracked source', async () => {
  const root = await makeRepo('hook-tool-source-');
  const home = await makeHome('hook-tool-home-');
  try {
    assert.equal(install(['--repo', root], home).status, 0);
    const installed = await fs.readFile(path.join(root, '.git/hooks/post-commit'), 'utf8');
    const source = await fs.readFile(SOURCE, 'utf8');
    // The composed file is the source plus the marker block inserted after the
    // shebang; strip that block and the two must be byte-identical, or the
    // installed hook has drifted from the tracked one.
    const stripped = installed.replace(
      /\n\n# Installed by loey-space-mcp tools\/install-hook\.mjs\n# Source: [^\n]*\n/,
      ''
    );
    assert.equal(stripped, source);
  } finally {
    await fs.rm(root, {recursive: true, force: true});
    await fs.rm(home, {recursive: true, force: true});
  }
});
