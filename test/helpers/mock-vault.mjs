import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

export async function createMockVault(prefix = 'loey-test-vault-') {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));

  // Allowed root markdown files
  await fs.writeFile(path.join(root, 'Home.md'), '# Home\nLine 2\nLine 3\nLine 4\nLine 5\nLine 6\nLine 7\nLine 8\nLine 9\nLine 10\n');
  await fs.writeFile(path.join(root, 'memory.md'), '# Memory\nPersistent truths');
  await fs.writeFile(path.join(root, 'handoff.md'), '# Handoff\n### Latest Updates\n- Initial handoff entry\n');
  await fs.writeFile(path.join(root, 'AGENTS.md'), '# Operating Manual');

  // Disallowed root files
  await fs.writeFile(path.join(root, 'package.json'), '{"name":"mock-vault"}');
  await fs.writeFile(path.join(root, '.gitignore'), 'node_modules\n.env\n');
  await fs.writeFile(path.join(root, '.env'), 'SECRET_TOKEN=12345\n');

  // Allowed directories
  const allowedDirs = [
    '00-Inbox',
    '01-Daily/2026-10',
    '02-Projects/FastDesk',
    '03-Dev',
    '04-Learning',
    '06-Resources/Guides',
    '06-Resources/scripts',
    '07-Reviews',
    '08-Concepts',
    '99-Templates'
  ];
  for (const d of allowedDirs) {
    await fs.mkdir(path.join(root, d), { recursive: true });
  }

  await fs.writeFile(path.join(root, '00-Inbox/quick-capture-dump.md'), '# Quick Capture\n- [ ] Inbox task');
  await fs.writeFile(path.join(root, '01-Daily/2026-10/2026-10-18.md'), '# Sunday, October 18, 2026\n## 📝 Daily Log\n- **10:00**: Morning start\n');
  await fs.writeFile(path.join(root, '02-Projects/FastDesk/FastDesk.md'), '# FastDesk\nProject master note');
  await fs.writeFile(path.join(root, '06-Resources/scripts/heyloey.js'), '// Non-markdown script');
  await fs.writeFile(path.join(root, '99-Templates/Daily.md'), '# Daily Template');

  // Disallowed / private directories
  const privateDirs = ['00-Private', '05-Personal', '.secrets', '.git'];
  for (const d of privateDirs) {
    await fs.mkdir(path.join(root, d), { recursive: true });
  }
  await fs.writeFile(path.join(root, '00-Private/SOUL.md'), '# Persona & Vitals');
  await fs.writeFile(path.join(root, '05-Personal/finance.md'), '# Personal Finance');
  await fs.writeFile(path.join(root, '.secrets/tokens.json'), '{"key":"secret"}');

  return {
    root,
    async cleanup() {
      await fs.rm(root, { recursive: true, force: true });
    }
  };
}
