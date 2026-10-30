import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs/promises';
import os from 'node:os';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {createMockVault} from './helpers/mock-vault.mjs';
import {searchVaultRunbooks} from '../src/hybrid-search.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CANONICAL_CLI = path.resolve(__dirname, '../canonical/heyloey.cjs');

async function seed(vault) {
  await fs.writeFile(
    path.join(vault.root, '03-Dev', 'Docker WSL mount failure.md'),
    [
      '# 💻 Docker WSL mount failure',
      '',
      '> Docker container fails when the WSL bind mount goes stale.',
      '',
      '## 🔍 Root Cause & Procedural Fix',
      '- Restart the container to refresh the stale mount.',
      '- Verify the daemon is healthy.'
    ].join('\n')
  );
}

function cliEnv(vault) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('LOEY_')));
  env.LOEY_SPACE_DIR = vault.root;
  env.LOEY_LOCK_DIR = path.join(vault.root, '.test-locks');
  return env;
}

test('the module and the canonical CLI report the same BM25 result', async () => {
  const vault = await createMockVault('loey-search-parity-');
  try {
    await seed(vault);
    const hits = searchVaultRunbooks(vault.root, 'container bind mount stale');
    assert.equal(hits.length, 1);
    assert.equal(hits[0].relPath, '03-Dev/Docker WSL mount failure.md');
    assert.ok(hits[0].score > 0);

    const result = spawnSync(process.execPath, [CANONICAL_CLI, 'context', 'container bind mount stale'], {
      encoding: 'utf8',
      env: cliEnv(vault)
    });
    assert.equal(result.status, 0, result.stderr);
    assert.ok(result.stdout.includes('03-Dev/Docker WSL mount failure.md'));
    assert.ok(result.stdout.includes(`score: ${hits[0].score}`), 'CLI and module must report one score');
  } finally {
    await vault.cleanup();
  }
});

test('the canonical CLI resolves the shared engine when invoked through a symlink', async () => {
  const vault = await createMockVault('loey-search-symlink-');
  const linkDir = await fs.mkdtemp(path.join(os.tmpdir(), 'loey-search-link-'));
  try {
    await seed(vault);
    const link = path.join(linkDir, 'heyloey');
    await fs.symlink(CANONICAL_CLI, link);
    const result = spawnSync(process.execPath, [link, 'context', 'container bind mount stale'], {
      encoding: 'utf8',
      env: cliEnv(vault)
    });
    assert.equal(result.status, 0, result.stderr);
    assert.ok(result.stdout.includes('03-Dev/Docker WSL mount failure.md'), 'symlinked CLI must load src/search-engine.cjs');
  } finally {
    await fs.rm(linkDir, {recursive: true, force: true});
    await vault.cleanup();
  }
});

test('a vendored single-directory copy resolves ./src/search-engine.cjs', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'loey-vendored-'));
  const vaultDir = path.join(dir, 'vault');
  try {
    await fs.mkdir(vaultDir, {recursive: true});
    await fs.mkdir(path.join(dir, 'tool', 'src'), {recursive: true});
    await fs.copyFile(CANONICAL_CLI, path.join(dir, 'tool', 'heyloey.cjs'));
    await fs.copyFile(path.join(__dirname, '../src/search-engine.cjs'), path.join(dir, 'tool', 'src', 'search-engine.cjs'));

    const result = spawnSync(process.execPath, [path.join(dir, 'tool', 'heyloey.cjs'), '--root', vaultDir, 'status'], {encoding: 'utf8'});
    assert.equal(result.status, 0, result.stderr);
    assert.ok(result.stdout.includes('source: --root'));
  } finally {
    await fs.rm(dir, {recursive: true, force: true});
  }
});
