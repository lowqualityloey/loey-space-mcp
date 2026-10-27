import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const INSTALLER = path.join(REPO, 'tools', 'install-cli.mjs');
const CANONICAL = fs.realpathSync(path.join(REPO, 'canonical', 'heyloey.cjs'));

function sandbox(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loey-install-'));
  const home = path.join(root, 'home');
  const dest = path.join(root, 'bin', 'heyloey');
  fs.mkdirSync(home, {recursive: true});
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  return {
    root,
    home,
    dest,
    backups: path.join(home, '.local', 'state', 'heyloey', 'backups'),
    run(extra = []) {
      return spawnSync(process.execPath, [INSTALLER, ...extra, '--dest', dest], {
        encoding: 'utf8',
        env: {...process.env, HOME: home},
      });
    },
  };
}

test('installer - fresh install links the canonical artifact', (t) => {
  const s = sandbox(t);
  const result = s.run();
  assert.equal(result.status, 0, result.stderr);
  assert.ok(fs.lstatSync(s.dest).isSymbolicLink(), 'destination should be a symlink');
  assert.equal(fs.realpathSync(s.dest), CANONICAL);
});

test('installer - a second run is a no-op and writes no backup', (t) => {
  const s = sandbox(t);
  assert.equal(s.run().status, 0);
  const second = s.run();
  assert.equal(second.status, 0, second.stderr);
  assert.match(second.stdout, /already installed/);
  assert.equal(fs.realpathSync(s.dest), CANONICAL);
  assert.equal(fs.existsSync(s.backups) ? fs.readdirSync(s.backups).length : 0, 0);
});

test('installer - replaces an identical regular file and keeps a backup', (t) => {
  const s = sandbox(t);
  fs.mkdirSync(path.dirname(s.dest), {recursive: true});
  fs.copyFileSync(CANONICAL, s.dest);
  fs.chmodSync(s.dest, 0o755);

  const result = s.run();
  assert.equal(result.status, 0, result.stderr);
  assert.ok(fs.lstatSync(s.dest).isSymbolicLink());
  assert.equal(fs.realpathSync(s.dest), CANONICAL);

  const backups = fs.readdirSync(s.backups).filter((name) => name.endsWith('.bak'));
  assert.equal(backups.length, 1, 'exactly one backup expected');
  const backup = path.join(s.backups, backups[0]);
  assert.equal(fs.readFileSync(backup, 'utf8'), fs.readFileSync(CANONICAL, 'utf8'));
  assert.equal(fs.statSync(backup).mode & 0o777, 0o755, 'backup keeps the original mode');
});

test('installer - refuses to overwrite a differing regular file', (t) => {
  const s = sandbox(t);
  fs.mkdirSync(path.dirname(s.dest), {recursive: true});
  fs.writeFileSync(s.dest, '#!/bin/sh\necho custom\n', {mode: 0o755});
  const before = fs.readFileSync(s.dest, 'utf8');

  const result = s.run();
  assert.equal(result.status, 1);
  assert.match(result.stderr, /refusing to replace/);
  assert.ok(fs.lstatSync(s.dest).isFile(), 'destination must be untouched');
  assert.equal(fs.readFileSync(s.dest, 'utf8'), before);
  assert.equal(fs.existsSync(s.backups), false, 'a refusal writes no backup');
});

test('installer - refuses a foreign symlink, then replaces it with --force', (t) => {
  const s = sandbox(t);
  fs.mkdirSync(path.dirname(s.dest), {recursive: true});
  const foreign = path.join(s.root, 'other-cli');
  fs.writeFileSync(foreign, '#!/bin/sh\nexit 0\n', {mode: 0o755});
  fs.symlinkSync(foreign, s.dest);

  const refused = s.run();
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /refusing to replace/);
  assert.equal(fs.realpathSync(s.dest), fs.realpathSync(foreign));

  const forced = s.run(['--force']);
  assert.equal(forced.status, 0, forced.stderr);
  assert.equal(fs.realpathSync(s.dest), CANONICAL);
  const links = fs.readdirSync(s.backups).filter((name) => name.endsWith('.symlink'));
  assert.equal(links.length, 1, 'the replaced symlink is preserved');
});

test('installer - --dry-run changes nothing', (t) => {
  const s = sandbox(t);
  const result = s.run(['--dry-run']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /would install/);
  assert.equal(fs.existsSync(s.dest), false);
});

test('installer - refuses to install from a temporary checkout', (t) => {
  const fake = fs.mkdtempSync(path.join(os.tmpdir(), 'loey-fake-clone-'));
  t.after(() => fs.rmSync(fake, {recursive: true, force: true}));
  fs.mkdirSync(path.join(fake, 'tools'));
  fs.mkdirSync(path.join(fake, 'canonical'));
  fs.copyFileSync(INSTALLER, path.join(fake, 'tools', 'install-cli.mjs'));
  fs.copyFileSync(CANONICAL, path.join(fake, 'canonical', 'heyloey.cjs'));

  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'loey-install-out-'));
  t.after(() => fs.rmSync(out, {recursive: true, force: true}));
  const dest = path.join(out, 'heyloey');

  const result = spawnSync(process.execPath, [path.join(fake, 'tools', 'install-cli.mjs'), '--dest', dest], {
    encoding: 'utf8',
    env: {...process.env, HOME: out},
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /temporary checkout/);
  assert.equal(fs.existsSync(dest), false);
});
