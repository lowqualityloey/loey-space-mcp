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
  return new Intl.DateTimeFormat('en-CA', {timeZone: 'Pacific/Auckland', year: 'numeric', month: '2-digit', day: '2-digit'}).format(new Date());
}

async function scaffold(vault) {
  const day = aucklandToday();
  const dailyPath = path.join(vault.root, '01-Daily', day.slice(0, 7), day + '.md');
  await fs.mkdir(path.dirname(dailyPath), {recursive: true});
  await fs.writeFile(dailyPath, '---\ntype: daily\n---\n# Today\n\n## 📝 Daily Log\n');
  const handoffPath = path.join(vault.root, 'handoff.md');
  await fs.writeFile(handoffPath, '---\ntype: handoff\n---\n# Handoff\n\n### Latest Updates\n');
  return {dailyPath, handoffPath};
}

function run(vault, args) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('LOEY_')));
  env.LOEY_SPACE_DIR = vault.root;
  env.LOEY_LOCK_DIR = path.join(vault.root, '.test-locks');
  return spawnSync(process.execPath, [CANONICAL_CLI, ...args], {encoding: 'utf8', env});
}

test('--dry-run previews every writer and changes no bytes', async () => {
  const vault = await createMockVault('loey-dryrun-');
  try {
    const {dailyPath, handoffPath} = await scaffold(vault);
    const before = [await fs.readFile(dailyPath, 'utf8'), await fs.readFile(handoffPath, 'utf8')];

    const cases = [
      ['done', 'dry run milestone text'],
      ['done', '--personal', 'owner dry entry'],
      ['log', 'dry run log entry'],
      ['handoff', 'dry run handoff entry'],
      ['learn', 'Dry Run Pattern', 'root cause and reusable fix'],
    ];
    for (const args of cases) {
      const result = run(vault, ['--dry-run', ...args]);
      assert.equal(result.status, 0, args.join(' ') + ' :: ' + result.stderr);
      assert.match(result.stdout, /DRY RUN - nothing written/);
    }

    const after = [await fs.readFile(dailyPath, 'utf8'), await fs.readFile(handoffPath, 'utf8')];
    assert.deepEqual(after, before, 'dry-run must not change either record');
  } finally {
    await vault.cleanup();
  }
});

test('--show-paths prints absolute targets; the default is vault-relative', async () => {
  const vault = await createMockVault('loey-showpaths-');
  try {
    await scaffold(vault);
    const relative = run(vault, ['--dry-run', 'done', 'relative path check']);
    assert.match(relative.stdout, /Vault: \./);

    const absolute = run(vault, ['--dry-run', '--show-paths', 'done', 'absolute path check']);
    assert.ok(absolute.stdout.includes('Vault: ' + vault.root));
  } finally {
    await vault.cleanup();
  }
});

test('--dry-run on a read-only command is refused', async () => {
  const vault = await createMockVault('loey-dryrun-readonly-');
  try {
    const result = run(vault, ['--dry-run', 'status']);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /writing commands only/);
  } finally {
    await vault.cleanup();
  }
});

test('done --personal writes the Personal Log and never touches handoff', async () => {
  const vault = await createMockVault('loey-done-personal-');
  try {
    const {dailyPath, handoffPath} = await scaffold(vault);
    const handoffBefore = await fs.readFile(handoffPath, 'utf8');

    const result = run(vault, ['done', '--personal', 'owner entry via shorthand']);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /RESULT done logged/);

    const daily = await fs.readFile(dailyPath, 'utf8');
    assert.match(daily, /### 🧍 Personal Log/);
    assert.ok(daily.includes('- **') && daily.includes('owner entry via shorthand'));
    assert.equal(await fs.readFile(handoffPath, 'utf8'), handoffBefore);
  } finally {
    await vault.cleanup();
  }
});

test('learn merges into a marked region and never overwrites a hand-written note', async () => {
  const vault = await createMockVault('loey-learn-merge-');
  try {
    const devDir = path.join(vault.root, '03-Dev');
    await fs.mkdir(devDir, {recursive: true});

    const first = run(vault, ['learn', 'Merge Pattern', 'first pattern body', '--lang=typescript']);
    assert.equal(first.status, 0, first.stderr);
    const target = path.join(devDir, 'Merge Pattern.md');
    const created = await fs.readFile(target, 'utf8');
    assert.ok(created.includes('<!-- heyloey-learn:start -->'));
    assert.ok(created.includes('first pattern body'));

    const repeat = run(vault, ['learn', 'Merge Pattern', 'first pattern body', '--lang=typescript']);
    assert.match(repeat.stdout, /already recorded/);
    assert.equal(await fs.readFile(target, 'utf8'), created, 'an identical repeat is a true no-op');

    // A hand-written note with the same title must survive with the pattern appended.
    await fs.writeFile(target, '# Hand-written notes\n\nKeep this sentence.\n');
    const collide = run(vault, ['learn', 'Merge Pattern', 'second pattern body', '--lang=typescript']);
    assert.equal(collide.status, 0, collide.stderr);
    const merged = await fs.readFile(target, 'utf8');
    assert.ok(merged.includes('Keep this sentence.'), 'hand-written content must survive');
    assert.ok(merged.includes('second pattern body'));
    assert.ok(merged.includes('<!-- heyloey-learn:end -->'));
  } finally {
    await vault.cleanup();
  }
});
