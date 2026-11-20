#!/usr/bin/env node
/**
 * Installer for the portable vault-milestone post-commit hook.
 *
 * `hooks/post-commit` in this repository is the single tracked source of the
 * hook that runs in every repository on this machine. It used to live only at
 * `~/.git-template/hooks/post-commit` on disk, which meant a fix made there was
 * invisible to version control and one machine re-imaging destroyed it.
 *
 * Default target is the user-level git template, so new repositories inherit it:
 *
 *     ~/.git-template/hooks/post-commit
 *
 * `--repo <path>` installs into an existing repository's own hook directory
 * instead (`git -C <path> rev-parse --git-path hooks`), for repositories created
 * before the template existed or that opt out of inheritance.
 *
 * Safety rules:
 *  - An existing target is copied to
 *    ~/.local/state/heyloey/hook-backups/<mirrored target path>.bak before it is
 *    replaced; nothing is ever deleted.
 *  - An existing target that differs from the source and was NOT written by this
 *    installer is refused unless --force is given, so a hand-maintained hook is
 *    never silently clobbered.
 *  - The swap is a single atomic rename in the destination directory, so a
 *    interrupted run leaves either the old hook or the new one, never half of
 *    one.
 *  - The installed file is chmod 0755: git silently skips a non-executable hook.
 *
 * Usage:
 *   node tools/install-hook.mjs [--repo <path>] [--force] [--dry-run] [--help]
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';

const REPO_ROOT = fs.realpathSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'));
const SOURCE = path.join(REPO_ROOT, 'hooks', 'post-commit');
const DEFAULT_TARGET = path.join(os.homedir(), '.git-template', 'hooks', 'post-commit');

/** Marks a file as written by this installer, so a re-run may replace it freely. */
const MARKER = '# Installed by loey-space-mcp tools/install-hook.mjs';

/**
 * Backups live outside the template directory on purpose. Git copies every file
 * in a template's hooks/ directory into each new repository, so a backup left
 * beside the hook becomes part of every future repository's .git/hooks — and a
 * test that counts "post-commit.bak-*" there then sees files it never wrote.
 */
const BACKUP_DIR = path.join(os.homedir(), '.local', 'state', 'heyloey', 'hook-backups');

/**
 * Mirror a target path under BACKUP_DIR so two different repositories never
 * share one backup name. Flattening to a basename alone would let installing
 * into a second repository silently overwrite the previous repository's backup.
 */
function backupPathFor(target) {
  const parts = target.split(/[\\/]+/).filter((part) => part && part !== ':' && !/^[A-Za-z]:$/.test(part));
  return path.join(BACKUP_DIR, ...parts) + '.bak';
}

function fail(message, code = 1) {
  console.error(`heyloey-hook: ${message}`);
  process.exit(code);
}

function usage() {
  console.log(`Usage: node tools/install-hook.mjs [options]

Install the vault-milestone post-commit hook from this repository.

Options:
  --repo <path>   Install into that repository's own hook directory
                  (default: the user-level git template, ~/.git-template)
  --force         Replace an existing hook this installer did not write
  --dry-run       Report what would happen; change nothing
  --help, -h      Show this help

The hook is inert unless a commit carries the trailer:

    HeyLoey-Milestone: <one-line summary>`);
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
  if (value === undefined || value.startsWith('--')) fail(`${name} needs a value`);
  args.splice(at, 2);
  return value;
}

const help = takeFlag('--help') || takeFlag('-h');
const force = takeFlag('--force');
const dryRun = takeFlag('--dry-run');
const repo = takeOption('--repo');

if (help) {
  usage();
  process.exit(0);
}
if (args.length) fail(`unexpected argument: ${args[0]}`);

if (!fs.existsSync(SOURCE)) fail(`tracked hook source is missing: ${SOURCE}`);

/** Resolve the destination hook path. */
function resolveTarget() {
  if (repo === null) return DEFAULT_TARGET;
  const repoPath = path.resolve(repo);
  if (!fs.existsSync(repoPath)) fail(`--repo does not exist: ${repoPath}`);
  let hooksDir;
  try {
    hooksDir = execFileSync('git', ['-C', repoPath, 'rev-parse', '--git-path', 'hooks'], {
      encoding: 'utf8'
    }).trim();
  } catch {
    fail(`--repo is not a git repository: ${repoPath}`);
  }
  return path.resolve(repoPath, hooksDir, 'post-commit');
}

const target = resolveTarget();
const sourceBytes = fs.readFileSync(SOURCE);

console.log(`heyloey-hook: source ${SOURCE}`);
console.log(`heyloey-hook: target ${target}`);

// Compose the installed file once: the tracked hook plus the install marker, so a
// later run recognises its own output and can compare against it exactly.
const markerLine = `\n\n${MARKER}\n# Source: hooks/post-commit in lowqualityloey/loey-space-mcp. Edit that file, not this one.\n`;
let composed = sourceBytes.toString('utf8');
if (!composed.includes(MARKER)) {
  // Keep the shebang first; insert the marker before the first non-shebang line.
  composed = composed.replace(/^(#![^\n]*\n)/, `$1${markerLine}`);
}
const installedBytes = Buffer.from(composed, 'utf8');

if (dryRun) {
  let state;
  if (!fs.existsSync(target)) state = 'would be created';
  else if (fs.readFileSync(target).equals(installedBytes)) state = 'already installed and up to date';
  else if (!fs.readFileSync(target).includes(MARKER) && !force) state = 'REFUSED: existing hook was not written by this installer (use --force)';
  else state = 'would be replaced (timestamped backup written first)';
  console.log(`heyloey-hook: dry run, nothing written: ${state}`);
  process.exit(0);
}

let backup = null;
if (fs.existsSync(target)) {
  const existing = fs.readFileSync(target);
  if (existing.equals(installedBytes)) {
    // Re-assert the executable bit; a copy that lost it would be skipped silently.
    fs.chmodSync(target, 0o755);
    console.log('heyloey-hook: already installed and up to date; executable bit confirmed.');
    process.exit(0);
  }
  if (!existing.includes(MARKER) && !force) {
    fail(
      `REFUSED: ${target} exists and was not written by this installer. Nothing changed.\n` +
        'heyloey-hook: re-run with --force to replace it; a timestamped backup is written first.'
    );
  }
  // A single backup per target, overwritten on each replacement: a history of
  // stale hook copies helps nobody and git would copy every one of them into new
  // repositories if they sat in the template directory.
  backup = backupPathFor(target);
  fs.mkdirSync(path.dirname(backup), {recursive: true});
  fs.copyFileSync(target, backup);
  console.log(`heyloey-hook: backed up the existing hook to ${backup}`);
}

fs.mkdirSync(path.dirname(target), {recursive: true});

// Atomic swap: write a sibling temp file, then rename over the target, so an
// interrupted run leaves either the old hook or the new one and never half of one.
const tmp = `${target}.tmp-${process.pid}`;
fs.writeFileSync(tmp, installedBytes, {mode: 0o755});
fs.chmodSync(tmp, 0o755);
fs.renameSync(tmp, target);
fs.chmodSync(target, 0o755);

console.log(`heyloey-hook: installed ${target} (mode 755).`);
console.log('heyloey-hook: inert unless a commit carries "HeyLoey-Milestone: <summary>".');
if (backup) console.log(`heyloey-hook: previous hook kept at ${backup}`);