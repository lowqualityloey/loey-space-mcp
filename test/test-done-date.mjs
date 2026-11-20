import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {createMockVault} from './helpers/mock-vault.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CANONICAL_CLI = path.resolve(__dirname, '../canonical/heyloey.cjs');

// 'done --date' exists so a milestone captured hours ago is filed in the day it happened.
// Two failure modes matter and neither is visible in stdout alone: a back-dated entry
// silently landing in today's note, and a back-dated run dragging the handoff's
// 'updated:' field into the past. Both are asserted against real file contents.

function aucklandToday() {
  return new Intl.DateTimeFormat('en-CA', {timeZone: 'Pacific/Auckland', year: 'numeric', month: '2-digit', day: '2-digit'}).format(new Date());
}

function shiftDay(day, delta) {
  const base = new Date(day + 'T00:00:00Z');
  base.setUTCDate(base.getUTCDate() + delta);
  return base.toISOString().slice(0, 10);
}

async function writeDay(vault, day) {
  const dailyPath = path.join(vault.root, '01-Daily', day.slice(0, 7), day + '.md');
  await fs.mkdir(path.dirname(dailyPath), {recursive: true});
  await fs.writeFile(dailyPath, '---\ntype: daily\n---\n# Day\n\n## \u{1F4DD} Daily Log\n');
  return dailyPath;
}

async function scaffold(vault, days) {
  const handoffPath = path.join(vault.root, 'handoff.md');
  await fs.writeFile(handoffPath, '---\ntype: handoff\nupdated: 2020-01-01\n---\n# Handoff\n\n### Latest Updates\n');
  const dailyPaths = {};
  for (const day of days) dailyPaths[day] = await writeDay(vault, day);
  return {handoffPath, dailyPaths};
}

function run(vault, args) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('LOEY_')));
  env.LOEY_SPACE_DIR = vault.root;
  env.LOEY_LOCK_DIR = path.join(vault.root, '.test-locks');
  return spawnSync(process.execPath, [CANONICAL_CLI, ...args], {encoding: 'utf8', env});
}

test('done --date writes into the named day, not today', async () => {
  const vault = await createMockVault('loey-done-date-');
  try {
    const today = aucklandToday();
    const yesterday = shiftDay(today, -1);
    const {dailyPaths, handoffPath} = await scaffold(vault, [today, yesterday]);
    const todayBefore = await fs.readFile(dailyPaths[today], 'utf8');

    const result = run(vault, ['done', '--date', yesterday, '--time', '23:50', 'back-dated milestone body']);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /RESULT done logged/);

    const filed = await fs.readFile(dailyPaths[yesterday], 'utf8');
    assert.ok(filed.includes('back-dated milestone body'), 'the entry belongs in the named day');
    assert.match(filed, /11:50&nbsp;PM/, 'the recorded clock time is the one supplied');
    assert.equal(await fs.readFile(dailyPaths[today], 'utf8'), todayBefore, 'today must be untouched');

    const handoff = await fs.readFile(handoffPath, 'utf8');
    assert.ok(handoff.includes('[20'), 'the handoff entry carries a dated stamp');
    assert.ok(handoff.includes(yesterday + ' 23:50'), 'the handoff stamp names the milestone day');
  } finally {
    await vault.cleanup();
  }
});

test('a back-dated milestone does not back-date the handoff updated field', async () => {
  const vault = await createMockVault('loey-done-date-updated-');
  try {
    const today = aucklandToday();
    const yesterday = shiftDay(today, -1);
    const {handoffPath} = await scaffold(vault, [today, yesterday]);

    const result = run(vault, ['done', '--date', yesterday, '--time', '23:50', 'updated field probe']);
    assert.equal(result.status, 0, result.stderr);

    const handoff = await fs.readFile(handoffPath, 'utf8');
    assert.ok(handoff.includes('updated: ' + today), 'updated: describes when the file was touched, which is now');
    assert.ok(!handoff.includes('updated: ' + yesterday), 'updated: must not follow the milestone day into the past');
  } finally {
    await vault.cleanup();
  }
});

test('done --date refuses when that day has no note and writes neither record', async () => {
  const vault = await createMockVault('loey-done-date-absent-');
  try {
    const today = aucklandToday();
    const missing = shiftDay(today, -5);
    const {dailyPaths, handoffPath} = await scaffold(vault, [today]);
    const todayBefore = await fs.readFile(dailyPaths[today], 'utf8');
    const handoffBefore = await fs.readFile(handoffPath, 'utf8');

    const result = run(vault, ['done', '--date', missing, 'absent day milestone']);
    assert.equal(result.status, 4, 'an absent record is a refusal, not a generic failure');
    assert.match(result.stderr, /is absent/);
    assert.equal(await fs.readFile(dailyPaths[today], 'utf8'), todayBefore);
    assert.equal(await fs.readFile(handoffPath, 'utf8'), handoffBefore);
  } finally {
    await vault.cleanup();
  }
});

test('done --date rejects an impossible day and a malformed time before writing', async () => {
  const vault = await createMockVault('loey-done-date-bad-');
  try {
    const today = aucklandToday();
    const {dailyPaths, handoffPath} = await scaffold(vault, [today]);
    const before = [await fs.readFile(dailyPaths[today], 'utf8'), await fs.readFile(handoffPath, 'utf8')];

    const impossible = run(vault, ['done', '--date', '2026-02-31', 'impossible day probe']);
    assert.equal(impossible.status, 1);
    assert.match(impossible.stderr, /must be a real YYYY-MM-DD day/);

    const badTime = run(vault, ['done', '--date', today, '--time', '24:30', 'bad time probe']);
    assert.equal(badTime.status, 1);
    assert.match(badTime.stderr, /must be 24-hour HH:MM/);

    const missingValue = run(vault, ['done', '--date']);
    assert.equal(missingValue.status, 1);
    assert.match(missingValue.stderr, /requires a value/);

    assert.deepEqual([await fs.readFile(dailyPaths[today], 'utf8'), await fs.readFile(handoffPath, 'utf8')], before);
  } finally {
    await vault.cleanup();
  }
});

test('done --date without --time keeps the current clock time', async () => {
  const vault = await createMockVault('loey-done-date-notime-');
  try {
    const today = aucklandToday();
    const yesterday = shiftDay(today, -1);
    const {dailyPaths} = await scaffold(vault, [today, yesterday]);

    const result = run(vault, ['done', '--date', yesterday, 'day without a time']);
    assert.equal(result.status, 0, result.stderr);

    const filed = await fs.readFile(dailyPaths[yesterday], 'utf8');
    assert.ok(filed.includes('day without a time'));
    assert.match(filed, /[01]?\d:[0-5]\d/, 'an unspecified time still gets a real clock stamp');
  } finally {
    await vault.cleanup();
  }
});

test('--date is refused for commands that are not done, rather than silently ignored', async () => {
  const vault = await createMockVault('loey-done-date-scope-');
  try {
    const today = aucklandToday();
    const yesterday = shiftDay(today, -1);
    const {dailyPaths} = await scaffold(vault, [today, yesterday]);
    const before = await fs.readFile(dailyPaths[yesterday], 'utf8');

    const result = run(vault, ['log', '--date', yesterday, 'log must not take a date']);
    assert.equal(result.status, 1, 'the flag is refused by name');
    assert.match(result.stderr, /only apply to done\/milestone/);
    assert.equal(await fs.readFile(dailyPaths[yesterday], 'utf8'), before, 'nothing is back-dated behind the guard');
  } finally {
    await vault.cleanup();
  }
});

test('--dry-run previews the back-dated target and changes nothing', async () => {
  const vault = await createMockVault('loey-done-date-dry-');
  try {
    const today = aucklandToday();
    const yesterday = shiftDay(today, -1);
    const {dailyPaths, handoffPath} = await scaffold(vault, [today, yesterday]);
    const before = [await fs.readFile(dailyPaths[yesterday], 'utf8'), await fs.readFile(handoffPath, 'utf8')];

    const result = run(vault, ['--dry-run', 'done', '--date', yesterday, '--time', '23:50', 'dry back-dated probe']);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /back-dated/);
    assert.ok(result.stdout.includes(yesterday), 'the preview names the note that would be written');

    assert.deepEqual([await fs.readFile(dailyPaths[yesterday], 'utf8'), await fs.readFile(handoffPath, 'utf8')], before);
  } finally {
    await vault.cleanup();
  }
});
