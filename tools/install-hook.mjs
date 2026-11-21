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
 * `--repo <path>` installs into an existing repository's hook directory, resolved
 * the way git resolves it (`git rev-parse --git-path hooks`, so `core.hooksPath`
 * is honoured), for repositories created before the template existed or that opt
 * out of inheritance.
 *
 * A hook directory named by `core.hooksPath` is often not a plain hooks directory
 * but a dispatcher another tool owns (lefthook, husky). Writing there replaces the
 * generated dispatcher, and every job it routed is then lost silently: the file
 * installed is never the one git would have run. Such a directory is refused even
 * under --force, and `--hooks-dir <path>` is the explicit way to name a different
 * destination instead.
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
  --repo <path>   Install into that repository's hook directory, resolved the
                  way git resolves it (core.hooksPath is honoured). A directory
                  owned by a hook dispatcher (lefthook, husky) is refused.
                  (default: the user-level git template, ~/.git-template)
  --hooks-dir <path>
                  Write into exactly this directory instead, bypassing --repo
                  resolution. Use it for the directory a dispatcher routes to.
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
const hooksDirOption = takeOption('--hooks-dir');

if (help) {
  usage();
  process.exit(0);
}
if (args.length) fail(`unexpected argument: ${args[0]}`);

if (!fs.existsSync(SOURCE)) fail(`tracked hook source is missing: ${SOURCE}`);

/**
 * Directories a dispatcher generator owns, recognised by the files it writes
 * beside the hooks themselves. lefthook leaves an ownership marker next to its
 * worktree-local shims; husky leaves a generated prelude.
 */
const DISPATCHER_MARKERS = ['.dsh-lefthook-owned', '.lefthook-owned', '_/husky.sh'];

function dispatcherOwner(hooksDir) {
  for (const marker of DISPATCHER_MARKERS) {
    if (fs.existsSync(path.join(hooksDir, marker))) return marker;
  }
  // A lefthook dispatcher identifies itself even when its marker file is absent.
  const post = path.join(hooksDir, 'post-commit');
  if (fs.existsSync(post)) {
    const head = fs.readFileSync(post, 'utf8').split('\\n', 40).join('\\n');
    if (head.startsWith('#!/bin/sh') && /call_lefthook run/.test(head)) return 'lefthook dispatcher';
  }
  return null;
}

/**
 * Resolve the destination hook path.
 *
 * `--hooks-dir` wins because it is the operator naming the destination. Otherwise
 * git decides, and when git points at a dispatcher-owned directory the install is
 * refused: writing there replaces the dispatcher, so every job it routed vanishes
 * with no error, and the installed hook is never the one git would have run.
 */
function resolveTarget() {
  if (hooksDirOption !== null) {
    return path.join(path.resolve(hooksDirOption), 'post-commit');
  }
  if (repo === null) return DEFAULT_TARGET;
  const repoPath = path.resolve(repo);
  if (!fs.existsSync(repoPath)) fail(`--repo does not exist: ${repoPath}`);
  let hooksPath;
  try {
    hooksPath = execFileSync('git', ['-C', repoPath, 'rev-parse', '--git-path', 'hooks'], {
      encoding: 'utf8'
    }).trim();
  } catch {
    fail(`--repo is not a git repository: ${repoPath}`);
  }
  const hooksDir = path.resolve(repoPath, hooksPath);
  const owner = dispatcherOwner(hooksDir);
  if (owner !== null) {
    fail(
      `REFUSED: ${hooksDir} is owned by a hook dispatcher (${owner}), not by this installer.\n` +
        `heyloey-hook: writing there would replace the dispatcher and silently drop every job it routed.\n` +
        `heyloey-hook: install beside it instead, e.g. --hooks-dir ${path.join(repoPath, '.git', 'hooks')}`
    );
  }
  return path.join(hooksDir, 'post-commit');
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