import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs/promises';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {createPolicy, runCanonical, createServer, resolveCliPath} from '../src/safe-mcp.mjs';
import {createMockVault} from './helpers/mock-vault.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MOCK_CLI = path.resolve(__dirname, 'helpers/mock-cli.cjs');
const CLIENT_SCHEMA = path.resolve(__dirname, '../clients/antigravity/heyloey_done.json');

test('createPolicy - boundary & path restrictions', async () => {
  const vault = await createMockVault();
  try {
    const policy = await createPolicy(vault.root);

    // Allowed root files
    assert.equal(policy.permitted(path.join(policy.root, 'Home.md'), false), true);
    assert.equal(policy.permitted(path.join(policy.root, 'memory.md'), false), true);
    assert.equal(policy.permitted(path.join(policy.root, 'handoff.md'), false), true);
    assert.equal(policy.permitted(path.join(policy.root, 'AGENTS.md'), false), true);

    // Disallowed root files
    assert.equal(policy.permitted(path.join(policy.root, 'package.json'), false), false);
    assert.equal(policy.permitted(path.join(policy.root, '.gitignore'), false), false);
    assert.equal(policy.permitted(path.join(policy.root, '.env'), false), false);

    // Allowed directories
    assert.equal(policy.permitted(path.join(policy.root, '00-Inbox'), true), true);
    assert.equal(policy.permitted(path.join(policy.root, '01-Daily'), true), true);
    assert.equal(policy.permitted(path.join(policy.root, '02-Projects'), true), true);
    assert.equal(policy.permitted(path.join(policy.root, '03-Dev'), true), true);

    // Disallowed / private directories
    assert.equal(policy.permitted(path.join(policy.root, '00-Private'), true), false);
    assert.equal(policy.permitted(path.join(policy.root, '05-Personal'), true), false);
    assert.equal(policy.permitted(path.join(policy.root, '.secrets'), true), false);
    assert.equal(policy.permitted(path.join(policy.root, '.git'), true), false);

    // Path traversal prevention
    assert.equal(policy.permitted('/etc/passwd', false), false);
    assert.equal(policy.permitted(path.join(policy.root, '../package.json'), false), false);

    // File type restriction in folders
    assert.equal(policy.permitted(path.join(policy.root, '02-Projects/FastDesk/FastDesk.md'), false), true);
    assert.equal(policy.permitted(path.join(policy.root, '06-Resources/scripts/heyloey.js'), false), false);
  } finally {
    await vault.cleanup();
  }
});

test('policy.resolve - traversal and null byte rejection', async () => {
  const vault = await createMockVault();
  try {
    const policy = await createPolicy(vault.root);

    await assert.rejects(
      async () => policy.resolve('Home.md\0.txt'),
      /Access denied by note policy/
    );

    await assert.rejects(
      async () => policy.resolve('../../etc/passwd'),
      /Access denied by note policy/
    );

    await assert.rejects(
      async () => policy.resolve('00-Private/SOUL.md'),
      /Access denied by note policy/
    );

    await assert.rejects(
      async () => policy.resolve('.env'),
      /Access denied by note policy/
    );

    const resolved = await policy.resolve('Home.md');
    assert.equal(resolved, path.join(policy.root, 'Home.md'));
  } finally {
    await vault.cleanup();
  }
});

test('policy.read - basic read and windowed offset paging', async () => {
  const vault = await createMockVault();
  try {
    const policy = await createPolicy(vault.root);

    // Default read from line 0
    const chunk1 = await policy.read('Home.md', 3, 0);
    assert.equal(chunk1.head, 3);
    assert.equal(chunk1.offset, 0);
    assert.ok(chunk1.totalLines > 3);
    assert.equal(chunk1.truncated, true);
    assert.ok(chunk1.next_cursor);
    const lines1 = chunk1.text.split('\n');
    assert.equal(lines1.length, 3);

    // Second window starting at offset 3
    const chunk2 = await policy.read('Home.md', 3, 3);
    assert.equal(chunk2.head, 3);
    assert.equal(chunk2.offset, 3);
    assert.equal(chunk2.totalLines, chunk1.totalLines);
    const lines2 = chunk2.text.split('\n');
    assert.equal(lines2.length, 3);
    assert.notDeepEqual(lines1, lines2);

    // Out of bounds offset returns empty text cleanly
    const outOfBounds = await policy.read('Home.md', 10, 999999);
    assert.equal(outOfBounds.text, '');
    assert.equal(outOfBounds.truncated, false);
    assert.equal(outOfBounds.next_cursor, null);
  } finally {
    await vault.cleanup();
  }
});

test('policy.read - long line partial continuation & source reconstruction', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'loey-test-longline-'));
  try {
    const originalContent = 'A'.repeat(24010) + '\nSECOND LINE\nTHIRD LINE';
    await fs.writeFile(path.join(tmpDir, 'Home.md'), originalContent);
    const policy = await createPolicy(tmpDir);

    // Page 1: head=1, reads first 24000 characters of line 0
    const page1 = await policy.read('Home.md', 1, 0, 0);
    assert.equal(page1.text.length, 24000);
    assert.equal(page1.truncated, true);
    assert.deepEqual(page1.next_cursor, { offset: 0, char_offset: 24000 });

    // Page 2: continue using next_cursor, retrieves the remaining 10 characters + subsequent line
    const page2 = await policy.read('Home.md', 2, page1.next_cursor.offset, page1.next_cursor.char_offset);
    assert.ok(page2.text.startsWith('A'.repeat(10)));
    assert.ok(page2.text.includes('SECOND LINE'));

    // Traverse all pages using cursor and assert perfect reconstruction
    let cursor = { offset: 0, char_offset: 0 };
    let reconstructed = '';
    while (cursor) {
      const page = await policy.read('Home.md', 2, cursor.offset, cursor.char_offset);
      if (cursor.char_offset > 0) {
        reconstructed += page.text;
      } else {
        reconstructed += (reconstructed.length > 0 ? '\n' : '') + page.text;
      }
      cursor = page.next_cursor;
    }
    assert.equal(reconstructed, originalContent, 'Reconstructed content must exactly match original fixture');
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('policy.list - directory listing filtering', async () => {
  const vault = await createMockVault();
  try {
    const policy = await createPolicy(vault.root);
    const entries = await policy.list('.');

    const names = entries.map(e => e.name);
    assert.ok(names.includes('00-Inbox'));
    assert.ok(names.includes('01-Daily'));
    assert.ok(names.includes('02-Projects'));
    assert.ok(names.includes('Home.md'));

    // Disallowed folders must never appear in listing
    assert.ok(!names.includes('00-Private'));
    assert.ok(!names.includes('05-Personal'));
    assert.ok(!names.includes('.secrets'));
    assert.ok(!names.includes('.git'));
    assert.ok(!names.includes('.env'));
  } finally {
    await vault.cleanup();
  }
});

test('runCanonical - unauthorized command rejection & lock-state', async () => {
  const vault = await createMockVault();
  try {
    const policy = await createPolicy(vault.root);

    await assert.rejects(
      async () => runCanonical(policy, 'rm', ['-rf'], { cli: MOCK_CLI }),
      /Unsupported canonical command/
    );

    const lockState = await runCanonical(policy, 'lock-state', [], { cli: MOCK_CLI });
    assert.equal(lockState.exitCode, 0);
    assert.equal(lockState.successful, true);
    assert.ok(lockState.output.includes('[heyloey] LOCK'));
  } finally {
    await vault.cleanup();
  }
});

test('runCanonical - descendant process teardown & bounded settlement', async () => {
  const vault = await createMockVault();
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'loey-test-orphan-'));
  const orphanCli = path.join(tmpDir, 'orphan.cjs');
  const pidPath = path.join(tmpDir, 'grandchild.pid');

  await fs.writeFile(
    orphanCli,
    `const {spawn}=require('node:child_process');const fs=require('node:fs');const child=spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{});process.stdout.write('A'.repeat(140000));setInterval(()=>{},1000);"],{stdio:['ignore',1,2]});fs.writeFileSync(${JSON.stringify(pidPath)},String(child.pid));setInterval(()=>{},1000);`
  );

  try {
    const policy = await createPolicy(vault.root);
    let settled = false;
    const pending = runCanonical(policy, 'lock-state', [], { cli: orphanCli }).then(
      value => { settled = true; return value; },
      error => { settled = true; return { error: error.message }; }
    );

    await new Promise(r => setTimeout(r, 1500));
    assert.equal(settled, true, 'Subprocess call must settle promptly without hanging on inherited pipes');

    const grandchildPid = Number(await fs.readFile(pidPath, 'utf8'));
    let descendantAlive = true;
    try { process.kill(grandchildPid, 0); } catch { descendantAlive = false; }
    assert.equal(descendantAlive, false, 'Descendant grandchild must be killed via process group SIGKILL');

    const result = await pending;
    assert.ok(result.error && result.error.includes('Canonical CLI did not complete'));
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
    await vault.cleanup();
  }
});

test('createServer - failure envelopes for brief/context/lock-state', async () => {
  const vault = await createMockVault();
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'loey-test-failure-'));
  const failureCli = path.join(tmpDir, 'failure.cjs');
  await fs.writeFile(failureCli, 'process.exit(42);');

  try {
    const server = await createServer({ vault: vault.root, cli: failureCli });
    for (const name of ['heyloey_brief', 'heyloey_context', 'heyloey_lock_state']) {
      const tool = server._registeredTools[name];
      assert.ok(tool, `Tool ${name} must be registered`);
      const result = await tool.handler(name === 'heyloey_context' ? { query: 'test' } : {});
      assert.equal(result.isError, true, `${name} must return isError: true when exitCode is non-zero`);
      const payload = JSON.parse(result.content[0].text);
      assert.equal(payload.exitCode, 42);
      assert.equal(payload.successful, false);
    }
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
    await vault.cleanup();
  }
});

test('createServer - schema alignment and parity for heyloey_done', async () => {
  const vault = await createMockVault();
  try {
    const server = await createServer({ vault: vault.root, cli: MOCK_CLI });
    const doneTool = server._registeredTools['heyloey_done'];
    assert.ok(doneTool);

    // Server Zod schema rejects input < 5 characters
    const parseResult = doneTool.inputSchema.safeParse({ summary: 'abc' });
    assert.equal(parseResult.success, false, 'Server schema must reject summaries with length < 5');

    // Server Zod schema rejects leading '--'
    const parseDashResult = doneTool.inputSchema.safeParse({ summary: '--flag-injection' });
    assert.equal(parseDashResult.success, false, 'Server schema must reject summaries starting with --');

    // Verify repository client schema parity
    const schemaJson = JSON.parse(await fs.readFile(CLIENT_SCHEMA, 'utf8'));
    assert.equal(
      schemaJson.parameters.properties.summary.minLength,
      5,
      'Client JSON schema must declare minLength: 5 matching server validation'
    );
  } finally {
    await vault.cleanup();
  }
});

test('createServer - read_text_file tool execution with offset and char_offset', async () => {
  const vault = await createMockVault();
  try {
    const server = await createServer({ vault: vault.root, cli: MOCK_CLI });
    const readTool = server._registeredTools['read_text_file'];
    assert.ok(readTool);

    const res = await readTool.handler({ path: 'Home.md', head: 5, offset: 2, char_offset: 0 });
    assert.equal(res.isError, false);
    const data = JSON.parse(res.content[0].text);
    assert.equal(data.head, 5);
    assert.equal(data.offset, 2);
    assert.equal(data.char_offset, 0);
    assert.ok(data.totalLines > 0);
    assert.equal(data.text.split('\n').length, 5);
  } finally {
    await vault.cleanup();
  }
});

test('policy.read - blank lines and boundary window preservation', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'loey-test-blanklines-'));
  try {
    const testCases = [
      ['leading-empty', '\n\nALPHA'],
      ['blank-window', 'PREVIOUS\n\n\nNEXT'],
      ['empty-line-after-cap', 'A'.repeat(24000) + '\n\nB']
    ];

    for (const [name, content] of testCases) {
      await fs.writeFile(path.join(tmpDir, 'Home.md'), content);
      const policy = await createPolicy(tmpDir);

      if (name === 'leading-empty') {
        const first = await policy.read('Home.md', 3, 0, 0);
        assert.equal(first.text, '\n\nALPHA', 'Leading empty lines must be preserved verbatim');
      } else if (name === 'blank-window') {
        const windowed = await policy.read('Home.md', 3, 1, 0);
        assert.equal(windowed.text, '\n\nNEXT', 'Blank lines at cursor window start must be preserved');
      }

      // Reconstruct entire document through paging
      let cursor = { offset: 0, char_offset: 0 };
      let reconstructed = '';
      let pages = 0;
      while (cursor && pages < 20) {
        const page = await policy.read('Home.md', 2, cursor.offset, cursor.char_offset);
        if (cursor.char_offset > 0) {
          reconstructed += page.text;
        } else {
          reconstructed += (reconstructed.length > 0 ? '\n' : '') + page.text;
        }
        cursor = page.next_cursor;
        pages++;
      }
      assert.equal(reconstructed, content, `Reconstructed content for ${name} must match fixture verbatim`);
    }
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('runCanonical - detached process group (flock pattern) teardown', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'loey-test-detached-'));
  const writerPath = path.join(tmpDir, 'writer.cjs');
  const wrapperPath = path.join(tmpDir, 'wrapper.cjs');
  const writerPidFile = path.join(tmpDir, 'writer.pid');
  const flockPidFile = path.join(tmpDir, 'flock.pid');

  const writerSource = `const fs=require('node:fs');process.on('SIGTERM',()=>{});fs.writeFileSync(${JSON.stringify(writerPidFile)},String(process.pid));process.stdout.write('A'.repeat(140000));setInterval(()=>{},1000);`;
  const wrapperSource = `const {spawn}=require('node:child_process');const fs=require('node:fs');const child=spawn('/usr/bin/flock',[${JSON.stringify(path.join(tmpDir, 'synthetic.flock'))},process.execPath,${JSON.stringify(writerPath)}],{stdio:'inherit',detached:true});fs.writeFileSync(${JSON.stringify(flockPidFile)},String(child.pid));process.on('SIGTERM',()=>{try{process.kill(-child.pid,'SIGTERM')}catch{}});child.on('exit',(code,signal)=>process.exit(signal?143:(code??1)));`;

  await fs.writeFile(writerPath, writerSource);
  await fs.writeFile(wrapperPath, wrapperSource);

  let writerPid, flockPid;
  try {
    const policy = await createPolicy(tmpDir);
    let settled = false;
    let result;
    const pending = runCanonical(policy, 'lock-state', [], { cli: wrapperPath }).then(
      value => { settled = true; result = value; },
      error => { settled = true; result = { error: error.message }; }
    );

    await new Promise(r => setTimeout(r, 2500));
    assert.equal(settled, true, 'Subprocess call must settle within teardown bounds');

    writerPid = Number(await fs.readFile(writerPidFile, 'utf8'));
    flockPid = Number(await fs.readFile(flockPidFile, 'utf8'));

    const isAlive = async pid => {
      try {
        const stat = await fs.readFile(`/proc/${pid}/stat`, 'utf8');
        return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[0] !== 'Z';
      } catch (err) {
        if (err.code === 'ENOENT') return false;
        throw err;
      }
    };

    const writerAlive = await isAlive(writerPid);
    const flockAlive = await isAlive(flockPid);

    assert.equal(writerAlive, false, 'Detached grandchild writer must not survive teardown');
    assert.equal(flockAlive, false, 'Detached intermediate flock must not survive teardown');

    await pending;
  } finally {
    if (flockPid) { try { process.kill(-flockPid, 'SIGKILL'); } catch {} }
    if (writerPid) { try { process.kill(writerPid, 'SIGKILL'); } catch {} }
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('createServer - enforces explicit vault root configuration', async () => {
  const origEnv = process.env.LOEY_VAULT_ROOT;
  delete process.env.LOEY_VAULT_ROOT;
  try {
    await assert.rejects(
      async () => createServer({}),
      /Vault root must be explicitly configured via options\.vault or LOEY_VAULT_ROOT/
    );
  } finally {
    if (origEnv !== undefined) process.env.LOEY_VAULT_ROOT = origEnv;
  }
});

test('resolveCliPath - resolves absolute path or command via PATH', async () => {
  // Absolute path returns as is
  assert.equal(resolveCliPath('/bin/ls'), '/bin/ls');

  // Command name resolves to absolute path via PATH
  const nodeResolved = resolveCliPath('node');
  assert.ok(path.isAbsolute(nodeResolved));

  // Non-existent command throws
  assert.throws(
    () => resolveCliPath('nonexistent-binary-12345'),
    /Canonical CLI executable not found: nonexistent-binary-12345/
  );
});

test('resolveCliPath - handles relative paths, literal shell metacharacters, and missing absolute files', async () => {
  // Relative path resolution
  const relativeCandidate = './canonical/heyloey.cjs';
  const resolvedRelative = resolveCliPath(relativeCandidate);
  assert.equal(resolvedRelative, path.resolve(relativeCandidate));

  // Shell metacharacters are treated literally without shell evaluation
  assert.throws(
    () => resolveCliPath('$(printf node)'),
    /Canonical CLI executable not found: \$\(printf node\)/
  );

  // Missing absolute path throws
  assert.throws(
    () => resolveCliPath('/tmp/nonexistent-heyloey-file-' + Date.now()),
    /Canonical CLI executable not found/
  );

  // Default without args or env resolves to bundled canonical CLI
  const origCliEnv = process.env.LOEY_CLI_PATH;
  delete process.env.LOEY_CLI_PATH;
  try {
    const defaultCli = resolveCliPath();
    assert.ok(path.isAbsolute(defaultCli));
    assert.ok(defaultCli.endsWith('canonical/heyloey.cjs'));
  } finally {
    if (origCliEnv !== undefined) process.env.LOEY_CLI_PATH = origCliEnv;
  }
});

test('launcher - enforces explicit absolute LOEY_VAULT_ROOT', async () => {
  const launcherPath = path.resolve(__dirname, '../bin/loey-space-mcp');
  const {spawnSync} = await import('node:child_process');

  // 1. Missing LOEY_VAULT_ROOT must exit 1
  const envNoRoot = { ...process.env };
  delete envNoRoot.LOEY_VAULT_ROOT;
  const runNoRoot = spawnSync(launcherPath, [], { env: envNoRoot, encoding: 'utf8' });
  assert.equal(runNoRoot.status, 1);
  assert.ok(runNoRoot.stderr.includes('LOEY_VAULT_ROOT is required'));

  // 2. Relative LOEY_VAULT_ROOT must exit 1
  const envRelRoot = { ...process.env, LOEY_VAULT_ROOT: './relative-vault' };
  const runRelRoot = spawnSync(launcherPath, [], { env: envRelRoot, encoding: 'utf8' });
  assert.equal(runRelRoot.status, 1);
  assert.ok(runRelRoot.stderr.includes('LOEY_VAULT_ROOT must be an absolute path'));

  // 3. Extra flags must exit 2
  const runExtraFlags = spawnSync(launcherPath, ['--extra-flag'], { env: process.env, encoding: 'utf8' });
  assert.equal(runExtraFlags.status, 2);
  assert.ok(runExtraFlags.stderr.includes('accepts no extra roots or flags'));
});

