import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {createMockVault} from './helpers/mock-vault.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CANONICAL_CLI = path.resolve(__dirname, '../canonical/heyloey.cjs');

function aucklandToday() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Pacific/Auckland', year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(new Date());
}

async function scaffold(vault) {
  const day = aucklandToday();
  const month = day.slice(0, 7);
  const dailyPath = path.join(vault.root, '01-Daily', month, `${day}.md`);
  await fs.mkdir(path.dirname(dailyPath), {recursive: true});
  await fs.writeFile(dailyPath, '---\ntype: daily\n---\n# Today\n\n## 📝 Daily Log\n');
  await fs.writeFile(path.join(vault.root, 'handoff.md'), '---\ntype: handoff\n---\n# Handoff\n\n### Latest Updates\n');
  return {dailyPath};
}

function envWithoutVault() {
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('LOEY_')));
  return env;
}

function run(args, env = envWithoutVault()) {
  return spawnSync(process.execPath, [CANONICAL_CLI, ...args], {encoding: 'utf8', env});
}

test('--root selects the vault for read-only and writing commands', async () => {
  const vault = await createMockVault('loey-root-write-');
  try {
    const {dailyPath} = await scaffold(vault);
    const write = run(['--root', vault.root, 'done', 'root flag milestone']);
    assert.equal(write.status, 0, write.stderr + write.stdout);
    assert.match(write.stdout, /RESULT done logged/);

    const daily = await fs.readFile(dailyPath, 'utf8');
    assert.ok(daily.includes('root flag milestone'), 'the flocked child must use the same --root vault');

    const equalsForm = run(['status', `--root=${vault.root}`]);
    assert.equal(equalsForm.status, 0, equalsForm.stderr);
    assert.ok(equalsForm.stdout.includes(`Vault: ${vault.root} (source: --root)`));
  } finally {
    await vault.cleanup();
  }
});

test('--root wins over the environment fallbacks', async () => {
  const chosen = await createMockVault('loey-root-chosen-');
  const ignored = await createMockVault('loey-root-ignored-');
  try {
    const env = {...envWithoutVault(), LOEY_SPACE_DIR: ignored.root, LOEY_VAULT_ROOT: ignored.root};
    const result = run(['--root', chosen.root, 'status'], env);
    assert.equal(result.status, 0, result.stderr);
    assert.ok(result.stdout.includes(`Vault: ${chosen.root} (source: --root)`));
    assert.ok(!result.stdout.includes(ignored.root));
  } finally {
    await chosen.cleanup();
    await ignored.cleanup();
  }
});

test('--root without a directory is refused before any command runs', async () => {
  const missing = run(['--root']);
  assert.equal(missing.status, 2);
  assert.match(missing.stderr, /--root requires a directory/);

  const emptyEquals = run(['--root=', 'status']);
  assert.equal(emptyEquals.status, 2);
  assert.match(emptyEquals.stderr, /--root requires a directory/);
});
