#!/usr/bin/env node
/**
 * Idempotent installer for the owner-facing `heyloey` command.
 *
 * Makes ~/.local/bin/heyloey a symlink to this checkout's canonical/heyloey.cjs,
 * so the installed command can never drift from the single editable source.
 *
 * Safety rules:
 *  - Refuses to install from a temporary checkout or a disposable git worktree.
 *  - Never follows an existing destination into an unrelated file.
 *  - An existing regular file is replaced only when it is byte-identical to the
 *    canonical artifact; a differing file is refused unless --force is given.
 *  - An existing symlink is accepted when it already resolves to the canonical
 *    artifact; any other target is refused unless --force is given.
 *  - The replaced entry is preserved under ~/.local/state/heyloey/backups/.
 *  - The swap is a single atomic rename.
 *
 * Usage:
 *   node tools/install-cli.mjs [--dest <path>] [--force] [--dry-run] [--help]
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';

const REPO_ROOT = fs.realpathSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'));
const CANONICAL = path.join(REPO_ROOT, 'canonical', 'heyloey.cjs');
const DEFAULT_DEST = path.join(os.homedir(), '.local', 'bin', 'heyloey');

function fail(message, code = 1) {
  console.error(`heyloey-install: ${message}`);
  process.exit(code);
}

function usage() {
  console.log(`Usage: node tools/install-cli.mjs [options]

Point the owner-facing \`heyloey\` command at this checkout's canonical CLI.

Options:
  --dest <path>   Destination path. Default: ~/.local/bin/heyloey
  --force         Replace an existing entry that is not the canonical symlink
  --dry-run       Report what would happen; change nothing
  --help, -h      Show this help

The installed command is an installation artifact. Edit canonical/heyloey.cjs,
never the installed path.`);
}

const args = process.argv.slice(2);
function takeFlag(name) {
  const at = args.indexOf(name);
  if (at === -1) return false;
  args.splice(at, 1);
  return true;
}
function takeOption(name) {
  const at = args.indexOf(name);
  if (at === -1) return null;
  const value = args[at + 1];
  if (value === undefined) fail(`${name} requires a value`, 2);
  args.splice(at, 2);
  return value;
}

if (takeFlag('--help') || takeFlag('-h')) {
  usage();
  process.exit(0);
}
const force = takeFlag('--force');
const dryRun = takeFlag('--dry-run');
const destOption = takeOption('--dest');
if (args.length > 0) fail(`unexpected argument: ${args.join(' ')}`, 2);

const dest = path.resolve(destOption ?? DEFAULT_DEST);
const backupDir = path.join(os.homedir(), '.local', 'state', 'heyloey', 'backups');

function samePath(a, b) {
  try {
    return fs.realpathSync(a) === fs.realpathSync(b);
  } catch {
    return false;
  }
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function isInside(child, parent) {
  const relative = path.relative(parent, child);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

// --- 1. Only install from a permanent checkout -------------------------------
const temporaryRoots = [
  ...new Set(
    [os.tmpdir(), '/tmp', '/var/tmp']
      .map((candidate) => {
        try {
          return fs.realpathSync(candidate);
        } catch {
          return null;
        }
      })
      .filter(Boolean)
  ),
];
for (const temporary of temporaryRoots) {
  if (REPO_ROOT === temporary || isInside(REPO_ROOT, temporary)) {
    fail(`refusing to install from a temporary checkout: ${REPO_ROOT}`);
  }
}
const dotGit = path.join(REPO_ROOT, '.git');
if (fs.existsSync(dotGit) && fs.statSync(dotGit).isFile()) {
  fail(`refusing to install from a git worktree (${dotGit} is a file); run this from the permanent clone`);
}
if (path.resolve(dest) === path.resolve(CANONICAL)) fail('destination is the canonical artifact itself');
if (isInside(dest, REPO_ROOT)) fail(`destination must be outside the repository: ${dest}`);

// --- 2. The source of truth must exist and be runnable ----------------------
let canonicalReal;
try {
  canonicalReal = fs.realpathSync(CANONICAL);
} catch {
  fail(`canonical CLI not found at ${CANONICAL}`);
}
if (!(fs.statSync(canonicalReal).mode & 0o111)) {
  fail(`canonical CLI is not executable: ${canonicalReal}`);
}

// --- 3. Inspect the destination without following it ------------------------
let existing = null;
try {
  existing = fs.lstatSync(dest);
} catch (error) {
  if (error.code !== 'ENOENT') fail(`cannot inspect ${dest}: ${error.message}`);
}

let action;
let replacedKind = null;
if (!existing) {
  action = 'install';
} else if (existing.isSymbolicLink()) {
  const target = fs.readlinkSync(dest);
  const resolved = path.resolve(path.dirname(dest), target);
  if (samePath(resolved, canonicalReal)) {
    action = 'noop';
  } else if (force) {
    action = 'replace';
    replacedKind = 'symlink';
  } else {
    fail(
      `refusing to replace ${dest}: it is a symlink to ${resolved}, not ${canonicalReal}. ` +
        'Re-run with --force to replace it (a backup is kept).'
    );
  }
} else if (existing.isFile()) {
  const identical = existing.size === fs.statSync(canonicalReal).size && sha256(dest) === sha256(canonicalReal);
  if (identical) {
    action = 'replace';
    replacedKind = 'identical file';
  } else if (force) {
    action = 'replace';
    replacedKind = 'differing file';
  } else {
    fail(
      `refusing to replace ${dest}: it is a regular file that differs from ${canonicalReal}. ` +
        'Move it aside or re-run with --force (a backup is kept).'
    );
  }
} else {
  fail(`refusing to replace ${dest}: it is not a regular file or symlink`);
}

// --- 4. Apply --------------------------------------------------------------
if (action === 'noop') {
  console.log(`heyloey-install: already installed: ${dest} -> ${canonicalReal}`);
  process.exit(0);
}

if (dryRun) {
  console.log(`heyloey-install: would ${action === 'install' ? 'install' : `replace (${replacedKind})`}: ${dest} -> ${canonicalReal}`);
  process.exit(0);
}

fs.mkdirSync(path.dirname(dest), {recursive: true});

let backupPath = null;
if (existing) {
  fs.mkdirSync(backupDir, {recursive: true, mode: 0o700});
  fs.chmodSync(path.dirname(backupDir), 0o700);
  fs.chmodSync(backupDir, 0o700);
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '');
  const extension = existing.isSymbolicLink() ? 'symlink' : 'bak';
  for (let counter = 0; ; counter += 1) {
    const candidate = path.join(backupDir, `heyloey-${stamp}${counter ? `-${counter}` : ''}.${extension}`);
    try {
      if (existing.isSymbolicLink()) {
        fs.symlinkSync(fs.readlinkSync(dest), candidate);
      } else {
        fs.copyFileSync(dest, candidate, fs.constants.COPYFILE_EXCL);
        fs.chmodSync(candidate, existing.mode & 0o7777);
      }
      backupPath = candidate;
      break;
    } catch (error) {
      if (error.code !== 'EEXIST' || counter >= 100) throw error;
    }
  }
}

const staging = path.join(path.dirname(dest), `.heyloey-install-${process.pid}-${Date.now()}`);
fs.symlinkSync(canonicalReal, staging);
try {
  fs.renameSync(staging, dest);
} catch (error) {
  try {
    fs.unlinkSync(staging);
  } catch {
    /* staging already gone */
  }
  fail(`atomic replace failed: ${error.message}`);
}

// --- 5. Verify the installed artifact --------------------------------------
const installed = fs.lstatSync(dest);
if (!installed.isSymbolicLink()) fail(`verification failed: ${dest} is not a symlink`);
if (fs.realpathSync(dest) !== canonicalReal) fail(`verification failed: ${dest} does not resolve to ${canonicalReal}`);

console.log(`heyloey-install: ${action === 'install' ? 'installed' : `replaced ${replacedKind}`}: ${dest} -> ${canonicalReal}`);
if (backupPath) console.log(`heyloey-install: backup: ${backupPath}`);
