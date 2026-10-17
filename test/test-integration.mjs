import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {createPolicy, runCanonical, createServer} from '../src/safe-mcp.mjs';
import {createMockVault} from './helpers/mock-vault.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CANONICAL_CLI = path.resolve(__dirname, '../canonical/heyloey.cjs');

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
    // Scaffold valid daily note matching today's date for canonical CLI
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
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
