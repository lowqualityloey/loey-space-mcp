import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {createPolicy, runCanonical, createServer} from '../src/safe-mcp.mjs';
import {createMockVault} from './helpers/mock-vault.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CANONICAL_CLI = path.resolve(__dirname, '../canonical/heyloey.cjs');
const LAUNCHER = path.resolve(__dirname, '../bin/loey-space-mcp');

test('integration: canonical CLI lock-state inspection', async () => {
  const vault = await createMockVault('loey-integration-lock-');
  try {
    const policy = await createPolicy(vault.root);
    const lockState = await runCanonical(policy, 'lock-state', [], { cli: CANONICAL_CLI });
    assert.equal(lockState.exitCode, 0);
    assert.equal(lockState.successful, true);
    assert.ok(lockState.output.includes('[heyloey] LOCK'));
  } finally {
    await vault.cleanup();
  }
});

test('integration: canonical CLI synthetic skip mode (exit 3, zero writes)', async () => {
  const vault = await createMockVault('loey-integration-synthetic-');
  try {
    const policy = await createPolicy(vault.root);
    const handoffPath = path.join(vault.root, 'handoff.md');
    const handoffBefore = await fs.readFile(handoffPath, 'utf8');

    // Run with synthetic mode enabled
    const origSynthetic = process.env.LOEY_SPACE_SYNTHETIC;
    process.env.LOEY_SPACE_SYNTHETIC = '1';
    let result;
    try {
      result = await runCanonical(policy, 'done', ['Verified synthetic milestone entry'], { cli: CANONICAL_CLI });
    } finally {
      if (origSynthetic !== undefined) process.env.LOEY_SPACE_SYNTHETIC = origSynthetic;
      else delete process.env.LOEY_SPACE_SYNTHETIC;
    }

    assert.equal(result.exitCode, 3, 'Synthetic mode must exit 3 (skipped)');
    assert.equal(result.successful, false);
    assert.ok(result.output.includes('RESULT done skipped'));

    const handoffAfter = await fs.readFile(handoffPath, 'utf8');
    assert.equal(handoffAfter, handoffBefore, 'Synthetic run must not modify records');
  } finally {
    await vault.cleanup();
  }
});

test('integration: canonical CLI live write in temporary mock vault', async () => {
  const vault = await createMockVault('loey-integration-live-');
  try {
    // Scaffold valid daily note matching today's date for canonical CLI (runs under TZ: Pacific/Auckland)
    const aucklandDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'Pacific/Auckland', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
    const [year, month, day] = aucklandDate.split('-');
    const todayDir = path.join(vault.root, `01-Daily/${year}-${month}`);
    await fs.mkdir(todayDir, { recursive: true });
    const todayNotePath = path.join(todayDir, `${year}-${month}-${day}.md`);
    await fs.writeFile(
      todayNotePath,
      `---\ntype: daily\n---\n# Today\n\n## 📝 Daily Log\n- **09:00**: Started day\n`
    );

    const handoffPath = path.join(vault.root, 'handoff.md');
    await fs.writeFile(
      handoffPath,
      `---\ntype: handoff\n---\n# Handoff\n\n### Latest Updates\n- Initial entry\n`
    );

    const policy = await createPolicy(vault.root);

    // Ensure synthetic flag is NOT set
    const origSynthetic = process.env.LOEY_SPACE_SYNTHETIC;
    delete process.env.LOEY_SPACE_SYNTHETIC;

    let result;
    try {
      result = await runCanonical(policy, 'done', ['Integration milestone shipped successfully'], { cli: CANONICAL_CLI });
    } finally {
      if (origSynthetic !== undefined) process.env.LOEY_SPACE_SYNTHETIC = origSynthetic;
    }

    assert.equal(result.exitCode, 0, 'Live write in temporary vault must exit 0');
    assert.equal(result.successful, true);
    assert.ok(result.output.includes('RESULT done logged'));

    // Verify record changes
    const dailyAfter = await fs.readFile(todayNotePath, 'utf8');
    assert.ok(dailyAfter.includes('Integration milestone shipped successfully'), 'Daily note must record milestone');

    const handoffAfter = await fs.readFile(handoffPath, 'utf8');
    assert.ok(handoffAfter.includes('Integration milestone shipped successfully'), 'Handoff must record milestone');
  } finally {
    await vault.cleanup();
  }
});

test('integration: launcher-selected CLI heyloey_learn and heyloey_done with scope over stdio', {timeout: 20000}, async () => {
  const vault = await createMockVault('loey-integration-learn-scope-');
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) =>
    !name.startsWith('LOEY_') && name !== 'FLOCK_BIN'
  ));
  const client = new Client({name: 'learn-scope-integration', version: '1.0.0'});
  const transport = new StdioClientTransport({
    command: LAUNCHER,
    cwd: vault.root,
    env: {
      ...env,
      NODE_BIN: process.execPath,
      LOEY_VAULT_ROOT: vault.root,
      LOEY_LOCK_DIR: path.join(vault.root, '.test-locks'),
      LOEY_SPACE_SYNTHETIC: '0',
    },
    stderr: 'pipe',
  });

  try {
    const today = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Pacific/Auckland', year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(new Date());
    const month = today.slice(0, 7);
    const dailyPath = path.join(vault.root, '01-Daily', month, `${today}.md`);
    await fs.mkdir(path.dirname(dailyPath), {recursive: true});
    await fs.writeFile(dailyPath, '# Fixture day\n\n## 📝 Daily Log\n\n> [!NOTE]- 🤖 Agent Milestone Log\n> | Time | Scope | Milestone |\n> | :--- | :--- | :--- |\n\n');

    await client.connect(transport);

    // 1. Test heyloey_learn over MCP
    const learnResponse = await client.callTool({
      name: 'heyloey_learn',
      arguments: {
        title: 'Stdio Learn Pattern',
        fix: 'Root cause: sandboxed filesystem. Fix: route through MCP safely.',
        lang: 'typescript'
      }
    });
    assert.notEqual(learnResponse.isError, true, 'the MCP learn call must succeed');
    const learnFile = path.join(vault.root, '03-Dev', 'Stdio Learn Pattern.md');
    const learnContent = await fs.readFile(learnFile, 'utf8');
    assert.ok(learnContent.includes('Stdio Learn Pattern'), 'runbook must have title');
    assert.ok(learnContent.includes('language: typescript'), 'runbook must have typescript language');

    // 2. Test heyloey_done with scope over MCP
    const doneResponse = await client.callTool({
      name: 'heyloey_done',
      arguments: {
        summary: 'Scope verification milestone',
        scope: 'my-project/dev'
      }
    });
    assert.notEqual(doneResponse.isError, true, 'the MCP done call with scope must succeed');
    const dailyContent = await fs.readFile(dailyPath, 'utf8');
    assert.ok(dailyContent.includes('Scope verification milestone'), 'daily note must have milestone');
    assert.ok(dailyContent.includes('`my-project` (`dev`)'), 'daily note scope column must format scope');
  } finally {
    try {
      await client.close();
    } finally {
      await vault.cleanup();
    }
  }
});

test('integration: launcher-selected CLI archives overflow as a classified review without losing milestones', {timeout: 20000}, async () => {
  const vault = await createMockVault('loey-integration-archive-');
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) =>
    !name.startsWith('LOEY_') && name !== 'FLOCK_BIN'
  ));
  const client = new Client({name: 'archive-regression', version: '1.0.0'});
  const transport = new StdioClientTransport({
    command: LAUNCHER,
    cwd: vault.root,
    env: {
      ...env,
      NODE_BIN: process.execPath,
      LOEY_VAULT_ROOT: vault.root,
      LOEY_LOCK_DIR: path.join(vault.root, '.test-locks'),
      LOEY_SPACE_SYNTHETIC: '0',
    },
    stderr: 'pipe',
  });

  try {
    const today = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Pacific/Auckland', year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(new Date());
    const month = today.slice(0, 7);
    const dailyPath = path.join(vault.root, '01-Daily', month, `${today}.md`);
    await fs.mkdir(path.dirname(dailyPath), {recursive: true});
    await fs.writeFile(dailyPath, '# Fixture day\n\n## 📝 Daily Log\n- **23:59**: Late fixture\n- **00:00**: Early fixture\n\n> [!NOTE]- 🤖 Agent Milestone Log\n> | Time | Scope | Milestone |\n> | :--- | :--- | :--- |\n> | 11:59&nbsp;PM | fixture | Last fixture row |\n> | 12:00&nbsp;AM | fixture | First fixture row |\n\n');

    const milestones = Array.from({length: 14}, (_, index) => `Fixture milestone ${String(index + 1).padStart(2, '0')}`);
    const handoffPath = path.join(vault.root, 'handoff.md');
    await fs.writeFile(handoffPath, '# Handoff\n\n### Latest Updates\n\n' +
      milestones.map(summary => `- [x] **[${today} 09:00]** ${summary}\n`).join(''));

    await client.connect(transport);
    const summary = 'Archive classification regression verified';
    const response = await client.callTool({name: 'heyloey_done', arguments: {summary}});
    assert.notEqual(response.isError, true, 'the MCP milestone call must succeed');
    const text = response.content.find(block => block.type === 'text');
    assert.ok(text, 'the MCP tool must return its canonical receipt');
    const result = JSON.parse(text.text);
    assert.equal(result.exitCode, 0);
    assert.equal(result.successful, true);
    assert.match(result.output, /RESULT done logged daily=written handoff=written/);
    assert.ok(result.output.includes(`target=${vault.root} source=LOEY_SPACE_DIR`), 'the receipt must target only the fixture');

    const archivePath = path.join(vault.root, '07-Reviews', `handoff-archive-${month}.md`);
    const archive = await fs.readFile(archivePath, 'utf8');
    const frontmatter = archive.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    assert.ok(frontmatter, 'the overflow archive must have frontmatter');
    assert.match(frontmatter[1], /^type: review\s*$/m);
    assert.match(frontmatter[1], /^kind: archive\s*$/m);
    const handoff = await fs.readFile(handoffPath, 'utf8');
    const daily = await fs.readFile(dailyPath, 'utf8');
    assert.equal((handoff.match(/^- \[x\] /gm) ?? []).length, 10);
    assert.equal((archive.match(/^- \[x\] /gm) ?? []).length, 5, 'the fixture must actually cross the overflow threshold');
    for (const milestone of milestones) {
      assert.equal((handoff + archive).split(milestone).length - 1, 1, `${milestone} must survive exactly once`);
    }
    assert.equal(handoff.split(summary).length - 1, 1);
    assert.equal(daily.split(summary).length - 1, 1);
    assert.ok(daily.indexOf('**12:00 AM**: Early fixture') < daily.indexOf('**11:59 PM**: Late fixture'));
    assert.ok(daily.indexOf('First fixture row') < daily.indexOf(summary));
    assert.ok(daily.indexOf(summary) < daily.indexOf('Last fixture row'));
    assert.doesNotMatch(daily, /\*\*(?:23:59|00:00)\*\*/);
    assert.equal(archive.includes(summary), false, 'the newest milestone must remain in the live handoff');
  } finally {
    try {
      await client.close();
    } finally {
      await vault.cleanup();
    }
  }
});
