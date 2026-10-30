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
  const handoffPath = path.join(vault.root, 'handoff.md');
  await fs.writeFile(handoffPath, '---\ntype: handoff\n---\n# Handoff\n\n### Latest Updates\n');
  return {dailyPath, handoffPath};
}

function cleanEnv(vault) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('LOEY_')));
  env.LOEY_SPACE_DIR = vault.root;
  env.LOEY_LOCK_DIR = path.join(vault.root, '.test-locks');
  return env;
}

function cli(vault, args) {
  return spawnSync(process.execPath, [CANONICAL_CLI, ...args], {encoding: 'utf8', env: cleanEnv(vault)});
}

test('done escapes HTML in daily and handoff records and still verifies the write', async () => {
  const vault = await createMockVault('loey-escape-done-');
  try {
    const {dailyPath, handoffPath} = await scaffold(vault);
    const result = cli(vault, ['done', 'fixed <img src=x onerror=alert(1)> handling']);
    assert.equal(result.status, 0, result.stderr + result.stdout);
    assert.match(result.stdout, /RESULT done logged/);

    const daily = await fs.readFile(dailyPath, 'utf8');
    const handoff = await fs.readFile(handoffPath, 'utf8');
    for (const [label, text] of [['daily', daily], ['handoff', handoff]]) {
      assert.ok(!text.includes('<img'), `${label} must not carry raw HTML`);
      assert.ok(text.includes('&lt;img'), `${label} must carry escaped HTML`);
    }
  } finally {
    await vault.cleanup();
  }
});

test('a milestone that is a substring of an existing entry is still logged', async () => {
  const vault = await createMockVault('loey-dedupe-substring-');
  try {
    const {dailyPath, handoffPath} = await scaffold(vault);
    const first = cli(vault, ['done', 'deploy']);
    assert.equal(first.status, 0, first.stderr);
    assert.match(first.stdout, /RESULT done logged/);

    const second = cli(vault, ['done', 'deploy v2']);
    assert.equal(second.status, 0, second.stderr);
    assert.match(second.stdout, /RESULT done logged/, 'a longer distinct milestone must be logged');

    const repeat = cli(vault, ['done', 'deploy']);
    assert.equal(repeat.status, 0, repeat.stderr);
    assert.match(repeat.stdout, /RESULT done already-recorded/);

    const daily = await fs.readFile(dailyPath, 'utf8');
    const handoff = await fs.readFile(handoffPath, 'utf8');
    assert.ok(daily.includes('deploy v2'));
    assert.ok(handoff.includes('deploy v2'));
  } finally {
    await vault.cleanup();
  }
});

test('personal entries are escaped and deduplicated by exact text', async () => {
  const vault = await createMockVault('loey-escape-personal-');
  try {
    const {dailyPath} = await scaffold(vault);
    const first = cli(vault, ['personal', 'note <b>bold</b> idea']);
    assert.equal(first.status, 0, first.stderr);
    const written = await fs.readFile(dailyPath, 'utf8');
    assert.ok(!written.includes('<b>bold</b>'), 'personal bullet must not carry raw HTML');
    assert.ok(written.includes('&lt;b>bold&lt;/b>'));

    const repeat = cli(vault, ['personal', 'note <b>bold</b> idea']);
    assert.match(repeat.stdout, /RESULT personal already-recorded/);
  } finally {
    await vault.cleanup();
  }
});
