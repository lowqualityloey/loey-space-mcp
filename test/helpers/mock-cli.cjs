#!/usr/bin/env node
const fs = require('fs');

if (process.env.MOCK_EXIT_CODE) {
  process.exit(Number(process.env.MOCK_EXIT_CODE));
}

const args = process.argv.slice(2);
const command = args[0];

if (!command) {
  process.stderr.write('Missing command\n');
  process.exit(1);
}

switch (command) {
  case 'lock-state':
    process.stdout.write('[heyloey] LOCK flock ready target=default source=default\n');
    process.exit(0);
    break;

  case 'brief':
    process.stdout.write('[heyloey] BRIEF active\n');
    process.exit(0);
    break;

  case 'context':
    process.stdout.write(`[heyloey] CONTEXT query="${args[1] ?? ''}" matches=2\n`);
    process.exit(0);
    break;

  case 'done': {
    const summary = args[1] ?? '';
    if (summary.includes('fail')) {
      process.stdout.write('[heyloey] RESULT done refused target=default source=default\n');
      process.exit(4);
    } else if (summary.includes('skip')) {
      process.stdout.write('[heyloey] RESULT done skipped target=default source=default\n');
      process.exit(3);
    } else {
      process.stdout.write('[heyloey] RESULT done logged target=default source=default\n');
      process.exit(0);
    }
    break;
  }

  default:
    process.stderr.write(`Unknown command: ${command}\n`);
    process.exit(2);
}
