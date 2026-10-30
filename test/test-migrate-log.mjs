import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(REPO, 'canonical', 'heyloey.cjs');

const PERSONAL = '### 🧍 Personal Log';
const AGENT = '### 🤖 Agent Milestones';

const LEGACY = `## 📝 Daily Log
- **09:00 AM**: fixed my bicycle
- **10:00 AM**: remediate the parser defect
  continued detail

> [!NOTE]- 🤖 Agent Milestone Log
> | Time | Scope | Milestone |
> | :--- | :--- | :--- |
> | 09:15&nbsp;AM | \`loey_space\` | reconciled from GitHub |

## 🌇 End of the Day
SENTINEL: the rest of the day must survive.
`;

function makeVault(t, body = LEGACY, date = '2026-10-20') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loey-migrate-'));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const note = path.join(root, '01-Daily', date.slice(0, 7), `${date}.md`);
  fs.mkdirSync(path.dirname(note), {recursive: true});
  fs.writeFileSync(note, body, 'utf8');
  return {
    root,
    note,
    read: () => fs.readFileSync(note, 'utf8'),
    run(args = [], target = date) {
      return spawnSync(process.execPath, [CLI, 'migrate-log', '--date', target, ...args], {
        encoding: 'utf8',
        env: {...process.env, LOEY_SPACE_DIR: root, LOEY_LOCK_DIR: path.join(root, '.locks')},
      });
    },
  };
}

/** Read one area independently of the code under test. */
function areaOf(content, heading) {
  const lines = content.split('\n');
  const start = lines.findIndex((line) => line.trim() === heading);
  assert.notEqual(start, -1, `the note must carry ${heading}:\n${content}`);
  let end = start + 1;
  while (end < lines.length && !/^#{1,3}\s/.test(lines[end]) && lines[end].trim() !== '---') end += 1;
  return lines.slice(start + 1, end).join('\n');
}

test('migrate-log never moves a personal entry by its wording', (t) => {
  const v = makeVault(t);
  const result = v.run();
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /RESULT migrate-log logged/);
  // The legacy callout is folded inside the agent area, so nothing is relocated (adopted=0);
  // the vault CLI reports the same counts on this fixture.
  assert.match(result.stdout, /migrated=0 kept=2 adopted=0/);

  const note = v.read();
  assert.match(areaOf(note, PERSONAL), /- \*\*09:00 AM\*\*: fixed my bicycle/);
  assert.match(areaOf(note, PERSONAL), /- \*\*10:00 AM\*\*: remediate the parser defect/);
  assert.match(areaOf(note, AGENT), /reconciled from GitHub/);
});

test('migrate-log --select-summary moves exactly the named entry into the agent table', (t) => {
  const v = makeVault(t);
  const result = v.run(['--select-summary', 'parser defect']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /migrated=1 kept=1 adopted=0/);

  const note = v.read();
  assert.match(areaOf(note, AGENT), /\| 10:00&nbsp;AM \| {2}\| remediate the parser defect<br>continued detail \|/);
  assert.doesNotMatch(areaOf(note, PERSONAL), /remediate the parser defect/);
  assert.match(areaOf(note, PERSONAL), /fixed my bicycle/);
});

test('migrate-log --select moves by time and keeps the scope cell blank', (t) => {
  const v = makeVault(t);
  const result = v.run(['--select', '09:00 AM']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /migrated=1 kept=1/);

  const agent = areaOf(v.read(), AGENT);
  assert.match(agent, /\| 09:00&nbsp;AM \| {2}\| fixed my bicycle \|/);
});

test('migrate-log refuses an ambiguous selection and writes nothing', (t) => {
  const v = makeVault(
    t,
    `## 📝 Daily Log
- **10:00 AM**: first thing
- **10:00 AM**: second thing

## 🌇 End of the Day
SENTINEL
`
  );
  const before = v.read();
  const result = v.run(['--select', '10:00 AM']);
  assert.equal(result.status, 4);
  assert.match(result.stderr, /matches 2 personal entries/);
  assert.equal(v.read(), before, 'an ambiguous selection must not rewrite the note');
});

test('migrate-log refuses an unmatched selection and writes nothing', (t) => {
  const v = makeVault(t);
  const before = v.read();
  const result = v.run(['--select-summary', 'not in this note']);
  assert.equal(result.status, 4);
  assert.match(result.stderr, /matches no timestamped personal entry/);
  assert.equal(v.read(), before);
});

test('migrate-log adopts a legacy agent callout and discards its label', (t) => {
  const v = makeVault(t);
  const result = v.run(['--select', '10:00 AM']);
  assert.equal(result.status, 0, result.stderr);
  const note = v.read();
  assert.match(note, /Show entries \(2\)/);
  assert.doesNotMatch(note, /Agent Milestone Log/);
  assert.equal((note.match(/\| Time \| Scope \| Milestone \|/g) ?? []).length, 1, 'exactly one table');
});

test('migrate-log --dry-run reports and writes nothing', (t) => {
  const v = makeVault(t);
  const before = v.read();
  const result = v.run(['--dry-run', '--select', '10:00 AM']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /DRY RUN/);
  assert.match(result.stdout, /left in place: fixed my bicycle/);
  assert.equal(v.read(), before);
});

test('a second migrate-log run does not rewrite the note', (t) => {
  const v = makeVault(t);
  assert.equal(v.run(['--select', '10:00 AM']).status, 0);
  const once = v.read();
  const again = v.run();
  assert.equal(again.status, 0, again.stderr);
  assert.match(again.stdout, /already-recorded/);
  assert.equal(v.read(), once);
});

test('migrate-log targets the date it is given, not today', (t) => {
  const v = makeVault(t, `## 📝 Daily Log
- **09:00 AM**: older note entry

## 🌇 End of the Day
SENTINEL
`, '2026-10-01');
  const other = path.join(v.root, '01-Daily', '2026-10', '2026-10-02.md');
  fs.writeFileSync(other, '## 📝 Daily Log\n- another day\n');
  const untouched = v.read();

  const result = v.run([], '2026-10-02');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(v.read(), untouched, 'the note for another date must not change');
  assert.match(fs.readFileSync(other, 'utf8'), /### 🧍 Personal Log/, 'the named date is migrated');
});

test('migrate-log refuses a note with no Daily Log section', (t) => {
  const v = makeVault(t, '# Tuesday\n\n## 🌇 End of the Day\nSENTINEL\n');
  const before = v.read();
  const result = v.run();
  assert.equal(result.status, 4);
  assert.match(result.stderr, /has no ## 📝 Daily Log section/);
  assert.equal(v.read(), before);
});

test('migrate-log moves a stranded area callout under its own heading, line for line', (t) => {
  const v = makeVault(t, `## 📝 Daily Log
> _A running timestamp of what happened today._

> [!NOTE]- 🐙 GitHub Activity Log (1 event — click to expand)
> | Time | Repo | Action | Details / Branch |
> | :--- | :--- | :--- | :--- |
> | 01:08&nbsp;PM | \`repo\` | 🐙 Push | \`main\`: fix |

- **09:00 AM**: fixed my bicycle

## 🌇 End of the Day
SENTINEL
`);
  const result = v.run();
  assert.equal(result.status, 0, result.stderr);

  const note = v.read();
  const github = areaOf(note, '### 🐙 GitHub Activity');
  assert.match(github, /> \[!NOTE\]- 🐙 GitHub Activity Log \(1 event/);
  assert.match(github, /\| 01:08&nbsp;PM \| `repo` \| 🐙 Push \| `main`: fix \|/);
  assert.match(areaOf(note, PERSONAL), /fixed my bicycle/);
  assert.match(note, /SENTINEL/);
});

test('migrate-log escapes & and < inside a row so one entry cannot break the table', (t) => {
  const v = makeVault(t, `## 📝 Daily Log
### 🤖 Agent Milestones
- **09:00 AM**: shipped A & B <b>bold</b>

## 🌇 End of the Day
SENTINEL
`);
  const result = v.run();
  assert.equal(result.status, 0, result.stderr);
  assert.match(areaOf(v.read(), AGENT), /shipped A &amp; B &lt;b>bold&lt;\/b>/);
});
