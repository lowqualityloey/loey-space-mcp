#!/usr/bin/env node

const fs = require('fs');
const os = require('os');
const path = require('path');
const { createHash } = require('crypto');
const { execSync, spawn } = require('child_process');

// --- Vault targeting (explicit and portable) --------------------------------
// Precedence, in full:
//   1. LOEY_SPACE_DIR    explicit override for this CLI
//   2. LOEY_VAULT_ROOT   the same variable the MCP launcher and server use
//   3. ~/loey_space      portable fallback; no machine-specific path is built in
// The resolved path AND which source produced it are reported by `status` and in
// the machine-readable RESULT line, so a caller never has to guess where a write went.
const DEFAULT_VAULT_DIR = path.join(os.homedir(), 'loey_space');
function resolveVaultTarget() {
  if (process.env.LOEY_SPACE_DIR) {
    return { dir: process.env.LOEY_SPACE_DIR, source: 'LOEY_SPACE_DIR' };
  }
  if (process.env.LOEY_VAULT_ROOT) {
    return { dir: process.env.LOEY_VAULT_ROOT, source: 'LOEY_VAULT_ROOT' };
  }
  return { dir: DEFAULT_VAULT_DIR, source: 'default' };
}
const VAULT_TARGET = resolveVaultTarget();
const VAULT_DIR = VAULT_TARGET.dir;
const MAX_HANDOFF_UPDATES = 10;

function aucklandStamp(date = /* @__PURE__ */ new Date()) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Pacific/Auckland",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23"
  }).formatToParts(date);
  const part = (name) => parts.find((value) => value.type === name).value;
  return { date: `${part("year")}-${part("month")}-${part("day")}`, time: `${part("hour")}:${part("minute")}` };
}
function minuteOfDay(value) {
  const match = value.replace(/&nbsp;|\u00a0/g, " ").trim().match(/^(\d{1,2}):(\d{2})(?:\s*(AM|PM))?$/i);
  if (!match)
    return null;
  let hour = Number(match[1]);
  const minute = Number(match[2]);
  if (minute > 59 || (match[3] ? hour < 1 || hour > 12 : hour > 23))
    return null;
  if (match[3])
    hour = hour % 12 + (match[3].toUpperCase() === "PM" ? 12 : 0);
  return hour * 60 + minute;
}
function displayLogTime(value, separator = " ") {
  const minutes = minuteOfDay(value);
  if (minutes === null)
    return value;
  const hour = Math.floor(minutes / 60);
  return `${String(hour % 12 || 12).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}${separator}${hour >= 12 ? "PM" : "AM"}`;
}
function normalizeDailyLog(content) {
  const newline = content.includes("\r\n") ? "\r\n" : "\n";
  const lines = content.split(newline);
  const start = lines.findIndex((line) => /^## 📝 Daily Log\s*$/.test(line));
  if (start < 0)
    return content;
  let end = start + 1;
  // The parent ends at the next `##` heading or divider. The `###` areas inside it are part of
  // the log, and each area's bullets and each table still form their own contiguous run below,
  // so they are timestamp-normalised and sorted independently, oldest first.
  while (end < lines.length && !/^#{1,2}\s|^---\s*$/.test(lines[end]))
    end++;
  // The agent area is owned by its one container. Its rows are quoted, and this loose pass is for
  // the areas that keep plain bullets; sorting the container here would reorder it by a rule that
  // knows nothing about the table shape, so `sortAgentTable` owns that area instead.
  const agentArea = logAreaBounds(lines, "agent");
  const agentEnd = agentArea ? agentArea.end : -1;
  let fenced = false;
  for (let i = start + 1; i < end; ) {
    if (agentArea && i >= agentArea.start && i < agentEnd) {
      i = agentEnd;
      continue;
    }
    if (/^\s*(```|~~~)/.test(lines[i])) {
      fenced = !fenced;
      i++;
      continue;
    }
    if (fenced) {
      i++;
      continue;
    }
    const bullet = (line) => line.match(/^(- \*\*\[?)([^\]*]+)(\]?\*\*(?::|\s).*)$/);
    const table = (line) => line.match(/^((?:> )?\|\s*)([^|]+?)(\s*\|.*)$/);
    const kind = bullet(lines[i]) ? bullet : table;
    const first = kind(lines[i]);
    if (!first || minuteOfDay(first[2]) === null) {
      i++;
      continue;
    }
    const entries = [];
    let cursor = i;
    while (cursor < end) {
      const match = kind(lines[cursor]);
      const minutes = match ? minuteOfDay(match[2]) : null;
      if (!match || minutes === null)
        break;
      const entry = [match[1] + displayLogTime(match[2], kind === table ? "&nbsp;" : " ") + match[3]];
      cursor++;
      if (kind === bullet) {
        while (cursor < end && /^(?: {2,}|\t)\S/.test(lines[cursor]))
          entry.push(lines[cursor++]);
      }
      entries.push({ minutes, lines: entry });
    }
    const sorted = entries.sort((a, b) => a.minutes - b.minutes).flatMap((entry) => entry.lines);
    lines.splice(i, cursor - i, ...sorted);
    i = cursor;
  }
  sortAgentTable(lines);
  return lines.join(newline);
}

function getTodayInfo(offsetDays = 0) {
  const stamp = aucklandStamp(new Date(Date.now() + offsetDays * 86400000));
  return { dateStr: stamp.date, monthDir: stamp.date.slice(0, 7), timeStr: stamp.time };
}

// --- Explicit synthetic-test opt-out ----------------------------------------
// Replaces the previous blanket path heuristics (`/tmp/*`, `*/.promptkit*`,
// `*/fixtures/*`, and a basename allow-list). A run is treated as synthetic ONLY
// when the caller says so:
//   * LOEY_SPACE_SYNTHETIC=1, or
//   * a `.loey-synthetic` sentinel file in the repo root or the working directory.
// An ordinary project checked out under /tmp is therefore logged normally.
const SYNTHETIC_ENV = 'LOEY_SPACE_SYNTHETIC';
const SYNTHETIC_SENTINEL = '.loey-synthetic';
function detectSynthetic() {
  if (process.env[SYNTHETIC_ENV] === '1') {
    return { synthetic: true, reason: `${SYNTHETIC_ENV}=1` };
  }
  const candidates = [];
  try {
    const repoPath = execSync('git rev-parse --show-toplevel 2>/dev/null', { encoding: 'utf8' }).trim();
    if (repoPath) candidates.push(repoPath);
  } catch (_) {}
  try {
    candidates.push(process.cwd());
  } catch (_) {}
  for (const dir of candidates) {
    if (dir && fs.existsSync(path.join(dir, SYNTHETIC_SENTINEL))) {
      return { synthetic: true, reason: `${SYNTHETIC_SENTINEL} in ${dir}` };
    }
  }
  return { synthetic: false, reason: null };
}

function vaultRel(p) {
  const rel = path.relative(VAULT_DIR, p);
  return rel && !rel.startsWith('..') ? rel : p;
}

// --- Vault write serialization (complete read-modify-write) ------------------
// Every vault writer runs its ENTIRE read-modify-write inside one cross-process
// lock, keyed by the RESOLVED vault identity, so a WSL caller and a Windows caller
// (the npm shims delegate with `wsl.exe -e <this file>`) serialize against each
// other instead of each replacing the file from a stale read.
//
// Division of labour, stated because it is easy to get wrong:
//   * the LOCK provides mutual exclusion (no lost updates);
//   * ATOMIC REPLACEMENT (temp file + rename, `atomicWriteFileSync`) guarantees a
//     reader never observes a torn/partial file. It is NOT the mutual exclusion and
//     is not a substitute for it: two writers can each atomically replace the file
//     with content derived from a stale read and still lose one entry.
// The lock is taken ONCE per process, before dispatch, so nested helpers such as
// `learn` -> daily log or `dream` -> handoff prune cannot deadlock on themselves.
//
// ONE IMPLEMENTATION, AND IT IS REQUIRED: the kernel-managed `flock`.
//
// Every command that writes vault records re-executes itself as a child of
// `flock -w <secs> <lockfile>`, so the KERNEL owns the lock: it arbitrates ownership
// between concurrent callers, it releases the lock when the holder exits FOR ANY
// REASON (including SIGKILL), and its ownership transitions are atomic. There is
// therefore NO stale state and NO takeover heuristic anywhere in this program. The
// only two things this code must get right are (a) refusing clearly, instead of
// writing, when the kernel lock cannot be obtained, and (b) never writing without it.
//
// WHY THE METADATA-FILE FALLBACK WAS REMOVED (gone, not merely disabled): that tier
// kept a lock file whose CONTENTS named the holder, so a holder that died without
// cleaning up left state that the next writer had to judge. Every such judgement is
// made by the writer rather than by the kernel, and liveness - the least bad of them -
// is still racy in exactly the ways that matter here: it is a check against an
// observed snapshot, so it can be defeated by pid reuse, by a holder paused on
// another host that shares the filesystem, or by a successor taking the name between
// the observation and the transition. A protocol whose safety depends on a heuristic
// about someone else's process should not guard vault records. `flock` makes the same
// decision atomically, in the kernel, against a file descriptor, so it cannot be
// wrong in those ways.
//
// CONSEQUENCES, stated plainly because they are the price of the simplification:
//   * `flock` is a HARD DEPENDENCY for every writer. It ships with util-linux, so it
//     is present on Linux and under Windows Subsystem for Linux; the supported
//     Windows path for this vault IS WSL, and the Windows shims already delegate to
//     `wsl.exe -e` (adapter proposal, and the migration runbook). Where `flock` is
//     missing, the CLI REFUSES (exit 8) before touching a record. It does not fall
//     back to another protocol.
//   * A REQUEST FOR THE REMOVED TIER IS REJECTED, NOT IGNORED. `LOEY_LOCK_IMPL=file`
//     (or any value other than `auto`/`flock`), and the retired file-tier knobs
//     `LOEY_LOCK_RECOVERY`, `LOEY_LOCK_STALE_MS` and `LOEY_LOCK_RECLAIM_DELAY_MS`,
//     are configuration errors (exit 8). Quietly resolving them to a different
//     protocol is precisely the failure mode this change exists to remove.
//   * LEGACY STATE IS NEVER ADOPTED. A metadata lock left by the removed tier is
//     never unlinked, never taken over and never treated as absent. While one exists,
//     every writer REFUSES (exit 9) pending operator review, because this version
//     cannot know whether the legacy writer that created it is still running, or
//     whether it is on another host sharing the lock directory. Migration must be
//     quiescent and explicitly verified; see MIGRATION-legacy-lock-and-flock.md.
//   * THE LOCK FILE CARRIES NO OWNERSHIP DATA. `flock` locks the INODE of an empty
//     rendezvous file, so the file's contents (if any) are meaningless and are never
//     read as a holder record. A leftover file from a finished run confers nothing.
//
// Exit codes for lock failures (documented in the adapter proposal and the help text):
//   7  lock contention   - timed out waiting for the kernel lock; nothing written
//   8  lock unavailable   - `flock` is missing/unusable, or the lock configuration
//                           names the removed tier; nothing written
//   9  legacy lock state  - a metadata lock from the removed tier is present; nothing
//                           written, nothing removed, pending operator review
const LOCK_TIMEOUT_MS = Number(process.env.LOEY_LOCK_TIMEOUT_MS || 15000);
const LOCK_IMPL_REQUESTED = String(process.env.LOEY_LOCK_IMPL || 'auto').toLowerCase();
const LOCK_ALREADY_HELD = process.env.LOEY_LOCK_HELD === '1';
// In the kernel tier this process is the flocked CHILD, and the process that actually
// holds the kernel lock is its parent (`flock`). Captured here, at startup, while that
// parent is still alive; `kernelLockOwnerGone()` re-checks it before any vault write, so
// a wrapper killed with SIGKILL (no handler can intercept that) cannot leave an orphaned
// writer that keeps writing after the kernel released the lock.
const LOCK_WRAPPER_PID = LOCK_ALREADY_HELD ? process.ppid : null;
// Inert by default; it exists to widen the critical section so the contention and
// orphan regressions are deterministic rather than racy.
const LOCK_HOLD_MS = Number(process.env.LOEY_LOCK_HOLD_MS || 0);
// Which protocol serialized this process's writes. Always 'flock' for a writer, and
// reported in the machine-readable RESULT line so a caller can prove it.
let LOCK_IMPL_IN_FORCE = 'none';

// Knobs that configured the REMOVED tier. Setting any of them is refused rather than
// ignored, so an operator's stale environment cannot silently change the protocol.
const RETIRED_LOCK_KNOBS = ['LOEY_LOCK_RECOVERY', 'LOEY_LOCK_STALE_MS', 'LOEY_LOCK_RECLAIM_DELAY_MS'];

/**
 * Configuration that names the removed tier. Returns a list of problems; empty means
 * the configuration is acceptable. Never reinterprets a value into another protocol.
 */
function obsoleteLockConfig() {
  const problems = [];
  if (LOCK_IMPL_REQUESTED !== 'auto' && LOCK_IMPL_REQUESTED !== 'flock') {
    problems.push(
      LOCK_IMPL_REQUESTED === 'file'
        ? 'LOEY_LOCK_IMPL=file requests the removed metadata-file tier (only auto|flock remain)'
        : `LOEY_LOCK_IMPL=${LOCK_IMPL_REQUESTED} is not a supported value (only auto|flock remain)`
    );
  }
  for (const knob of RETIRED_LOCK_KNOBS) {
    const value = process.env[knob];
    if (value !== undefined && String(value) !== '') {
      problems.push(`${knob}=${value} configured the removed metadata-file tier`);
    }
  }
  return problems;
}

function lockDirPath() {
  // A fixed location, NOT derived from TMPDIR: two callers with different TMPDIR
  // values (an interactive shell vs. a hook with its own TMPDIR) must still meet on
  // one lock. LOEY_LOCK_DIR exists for tests and multi-user hosts.
  return process.env.LOEY_LOCK_DIR || (fs.existsSync('/tmp') ? '/tmp/heyloey-locks' : path.join(os.tmpdir(), 'heyloey-locks'));
}

/** One lock per vault IDENTITY - however the path is spelled - not per path string. */
function vaultLockKey() {
  let identity = VAULT_DIR;
  try {
    identity = fs.realpathSync(VAULT_DIR);
  } catch (_) {}
  return createHash('sha1').update(identity).digest('hex').slice(0, 20);
}

/** The kernel lock file: `flock` locks this inode. It carries no ownership data. */
function kernelLockPath() {
  return path.join(lockDirPath(), `vault-${vaultLockKey()}.flock`);
}

/**
 * The name the REMOVED metadata-file tier used. Nothing in this program creates it,
 * locks it, reads it as ownership, renames it or deletes it: it is only ever
 * inspected, so that legacy state can be reported and refused.
 */
function legacyLockPath() {
  return path.join(lockDirPath(), `vault-${vaultLockKey()}.lock`);
}

/** Read-only inspection of legacy state. Mutates nothing. */
function legacyLockState() {
  const p = legacyLockPath();
  let st = null;
  try {
    st = fs.statSync(p);
  } catch (_) {
    return { path: p, present: false };
  }
  let meta = null;
  try {
    meta = JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (_) {
    meta = null;
  }
  return { path: p, present: true, size: st.size, mtimeMs: st.mtimeMs, meta };
}

/**
 * Advisory only, for the operator's review. NOTHING here authorizes a write, a
 * removal or a takeover - which is the whole point: this version has no code path
 * that acts on a liveness judgement.
 */
function legacyHolderLiveness(info) {
  if (!info || typeof info !== 'object' || !Number.isFinite(Number(info.pid))) {
    return 'advisory: metadata absent or unreadable, so no holder can be identified';
  }
  try {
    process.kill(Number(info.pid), 0);
  } catch (e) {
    if (e.code === 'ESRCH') return `advisory: pid ${info.pid} does not exist here (it may have exited, or it may be another host)`;
    if (e.code === 'EPERM') return `advisory: pid ${info.pid} exists but is not ours to signal`;
    return `advisory: liveness check failed (${e.code || 'unknown'}); assume the holder may still be alive`;
  }
  return `advisory: pid ${info.pid} exists (it may or may not be the legacy writer)`;
}

/**
 * Conservative handling of legacy state: report it, refuse, change nothing. Called
 * before the kernel lock is taken AND again inside the flocked child, so a legacy lock
 * that appears during the wait is still refused.
 */
function refuseIfLegacyLockPresent() {
  const state = legacyLockState();
  if (!state.present) return;
  const holder = state.meta
    ? `pid=${state.meta.pid} token=${state.meta.token || '?'} started=${state.meta.started || '?'} command=${state.meta.command || '?'}`
    : 'metadata unreadable';
  console.error(
    `[heyloey] LOCK legacy state: a metadata-file lock from the removed file tier exists at ${state.path} (${holder}; ${legacyHolderLiveness(state.meta)}).\n` +
      '[heyloey] LOCK legacy state: this version does not take it over, does not remove it, and will not write vault records while it is present.\n' +
      '[heyloey] LOCK legacy state: migration must be quiescent and verified by an operator: confirm no legacy writer is still running (and that no other host shares this lock directory), remove the file by hand, then re-run. Nothing was written.'
  );
  process.exit(OUTCOME_EXIT['legacy-lock-present']);
}

function safeCwd() {
  try {
    return process.cwd();
  } catch (_) {
    return null;
  }
}

/**
 * Is the process that holds the kernel lock on our behalf gone? Two independent
 * signals, because reparenting alone is not reliable (whether an orphan lands on pid 1
 * or on a subreaper is a property of the host, not of this code):
 *   * the captured wrapper pid no longer exists (ESRCH);
 *   * this process was reparented to pid 1 of its PID namespace.
 * A pid that was recycled by an unrelated process would read as "still held", which
 * fails in the SAFE direction (the writer keeps the lock it was granted).
 */
function kernelLockOwnerGone() {
  if (!LOCK_ALREADY_HELD) return false;
  if (process.ppid === 1) return true;
  if (LOCK_WRAPPER_PID && LOCK_WRAPPER_PID > 1) {
    try {
      process.kill(LOCK_WRAPPER_PID, 0);
    } catch (e) {
      if (e.code === 'ESRCH') return true;
    }
  }
  return false;
}

function assertKernelLockHeld() {
  if (!kernelLockOwnerGone()) return;
  console.error(
    '[heyloey] LOCK unavailable: the kernel lock wrapper is gone (it exited or was killed), so the kernel lock is no longer held; nothing written.\n' +
      '[heyloey] LOCK hint: re-run the command. Do NOT add another lock protocol to compensate: if the wrapper keeps dying, fix why it is being killed.'
  );
  process.exit(OUTCOME_EXIT['lock-unavailable']);
}

/**
 * Event-loop-friendly delay. This is not a style preference: a SYNCHRONOUS wait
 * (Atomics.wait) never returns to the event loop, so Node cannot deliver a queued
 * SIGINT/SIGTERM handler until the wait is over. Measured on the first revision of
 * this lock: a waiting contender ignored SIGTERM for 32s and only exited when its
 * holder died. Awaiting a timer keeps the signal handlers live.
 */
function delayAsync(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// --- The kernel lock: `flock`, required ---------------------------------------
let _flockChecked = false;
let _flockBin = null;
/**
 * Absolute path of `flock`, or null. There is exactly ONE implementation, so this
 * returns the protocol or nothing: it never selects an alternative.
 *
 * The absolute util-linux locations are probed before PATH, so the protocol is still found
 * when the caller's PATH is set but does not carry /usr/bin.
 *
 * NOT AVAILABLE ON NATIVE WINDOWS: `flock` is util-linux, so it exists on Linux and
 * under WSL and not in a cmd/PowerShell environment. This vault's supported Windows
 * path is WSL, and the Windows shims already delegate to `wsl.exe -e`; a native
 * Windows invocation therefore refuses (exit 8) rather than picking another protocol.
 */
function flockBinPath() {
  if (_flockChecked) return _flockBin;
  _flockChecked = true;
  if (process.platform === 'win32') return _flockBin;
  // The absolute util-linux locations are probed FIRST. A caller whose PATH is set but does
  // not carry /usr/bin (an empty PATH, a minimal service environment) must still find the one
  // protocol implementation: resolving through PATH alone is what made every writer refuse
  // to run while /usr/bin/flock was present on the host.
  for (const candidate of ['/usr/bin/flock', '/bin/flock']) {
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      _flockBin = candidate;
      return _flockBin;
    } catch (_) {}
  }
  // PATH stays the fallback for a host that installs flock somewhere else.
  try {
    const p = execSync('command -v flock 2>/dev/null', { encoding: 'utf8', shell: '/bin/sh' }).trim();
    if (p) _flockBin = p;
  } catch (_) {}
  return _flockBin;
}

/**
 * Re-execute the whole command as a child of
 * `flock -w <secs> -E 7 <lockfile> <node> <this file> <args...>`.
 *
 * The kernel owns the lock, so it is released when the holder exits FOR ANY REASON
 * (including SIGKILL) - there is no stale state to reclaim and no takeover heuristic
 * to get wrong. Signals are forwarded to the child so an interrupted parent cannot
 * leave a child writing in the background.
 */
function runUnderKernelLock() {
  return new Promise((resolve) => { // eslint-disable-line no-unused-vars
    const bin = flockBinPath();
    const p = kernelLockPath();
    try {
      fs.mkdirSync(path.dirname(p), { recursive: true });
    } catch (_) {}
    const secs = Math.max(1, Math.ceil(LOCK_TIMEOUT_MS / 1000));
    const child = spawn(
      bin,
      ['-w', String(secs), '-E', String(OUTCOME_EXIT['lock-contended']), p, process.execPath, __filename, ...process.argv.slice(2)],
      { stdio: 'inherit', detached: true, env: { ...process.env, LOEY_LOCK_HELD: '1', LOEY_LOCK_IMPL_USED: 'flock' } }
    );
    // `flock` FORKS: the command it runs is a GRANDCHILD of this process. Signalling
    // flock alone would kill the lock holder and orphan the writer, which would keep
    // writing after the lock was released - measured, and the reason `detached: true`
    // (own process group) plus a group signal are used here. (The earlier blocking
    // spawnSync could not signal at all and left the orphaned writer running.)
    _signalForwarder = (sig) => {
      try {
        process.kill(-child.pid, sig);
      } catch (_) {
        try {
          child.kill(sig);
        } catch (__) {}
      }
    };
    child.on('error', (e) => {
      console.error(`[heyloey] LOCK unavailable: kernel lock failed: ${e.message} (${p}); nothing written.`);
      process.exit(OUTCOME_EXIT['lock-unavailable']);
    });
    child.on('exit', (code, signal) => {
      if (signal) process.exit(signal === 'SIGINT' ? 130 : 143);
      if (code === OUTCOME_EXIT['lock-contended']) {
        console.error(
          `[heyloey] LOCK contention: timed out after ${LOCK_TIMEOUT_MS}ms waiting for ${p} (impl=flock, kernel-managed: the kernel releases the lock when its holder exits, so there is no stale state to recover); nothing written.`
        );
        process.exit(OUTCOME_EXIT['lock-contended']);
      }
      process.exit(code === null ? 1 : code);
    });
    // Deliberately never resolves: the 'exit' handler above terminates the process,
    // so the command must not run a second time here.
  });
}

/**
 * Run the command dispatcher and make its failure explicit. `dispatch()` is NOT
 * awaited: the vault writes stay synchronous once the lock is held, and the pending
 * promise (a timer while waiting, or a microtask afterwards) keeps the event loop
 * alive until the command itself calls process.exit.
 */
function runAsync(fn) {
  fn().catch((e) => {
    // There is nothing to release: the kernel releases the lock when the process
    // holding it exits, however it exits.
    console.error(`[heyloey] Error: ${e && e.message ? e.message : e}`);
    process.exit(OUTCOME_EXIT.failed);
  });
}

// There is no release path to run: the KERNEL owns the lock and drops it when the
// process that holds it exits, including on SIGKILL, where no handler runs at all.
// The process that must stop first is therefore the flock CHILD, so a signal is
// forwarded to the child's process group (see runUnderKernelLock) rather than
// releasing anything here.
let _signalForwarder = null;
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(sig, () => {
    if (_signalForwarder) {
      _signalForwarder(sig);
      return;
    }
    process.exit(sig === 'SIGINT' ? 130 : 143);
  });
}

/**
 * Atomic replacement: write a sibling temp file, fsync, then rename over the
 * target. Readers never see a torn file. This protects individual writes; the
 * lock above is what protects the read-modify-write sequence.
 */
function atomicWriteFileSync(filePath, content) {
  // Defence in depth for the kernel tier: this process writes vault records only while
  // the process holding the kernel lock on its behalf is still alive.
  assertKernelLockHeld();
  const dir = path.dirname(filePath);
  const tmp = path.join(dir, `.${path.basename(filePath)}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`);
  // Preserve the target's mode, and HONOUR a read-only target. Writing a sibling
  // temp file and renaming over the target would otherwise silently bypass the
  // target's own permission bits (measured: a `chmod 444` handoff.md was replaced
  // successfully), turning a documented refusal into a write.
  let targetMode = null;
  try {
    targetMode = fs.statSync(filePath).mode & 0o777;
  } catch (_) {}
  if (targetMode !== null) {
    fs.accessSync(filePath, fs.constants.W_OK);
  }
  let fd = null;
  try {
    fd = fs.openSync(tmp, 'wx', targetMode !== null ? targetMode : 0o644);
    fs.writeSync(fd, content);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    if (targetMode !== null) {
      try {
        fs.chmodSync(tmp, targetMode);
      } catch (_) {}
    }
    fs.renameSync(tmp, filePath);
  } catch (e) {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch (_) {}
    }
    try {
      fs.unlinkSync(tmp);
    } catch (_) {}
    throw e;
  }
}

/** Section-scoped containment check, used for final both-records verification. */
function verifySectionContains(filePath, headings, needle) {
  let content;
  try {
    content = fs.readFileSync(filePath, 'utf8');
  } catch (e) {
    return { ok: false, reason: e.message };
  }
  const body = sectionBody(content, headings);
  if (body === null) return { ok: false, reason: `${Array.isArray(headings) ? headings[0] : headings} section missing` };
  if (!body.includes(needle)) return { ok: false, reason: `entry not found inside ${Array.isArray(headings) ? headings[0] : headings}` };
  return { ok: true };
}

// Record statuses: written | already-recorded | missing | failed | skipped | not-attempted
// 'refused' means a required record was ABSENT; a write ERROR reports as 'failed'
// (exit 6) so the two are never conflated.
const OUTCOME_EXIT = {
  logged: 0,
  'already-recorded': 0,
  skipped: 3,
  refused: 4,
  partial: 5,
  failed: 6,
  // Lock failures are their own outcomes so a caller can never mistake "did not
  // run" for "nothing to do": 7 = another holder had it, 8 = the kernel lock is
  // missing or the configuration names the removed tier, 9 = legacy file-tier lock
  // state exists and needs an operator. In every one of them nothing was written.
  'lock-contended': 7,
  'lock-unavailable': 8,
  'legacy-lock-present': 9,
};

function summarizeOutcome(records, synthetic) {
  if (synthetic.synthetic) return 'skipped';
  const statuses = records.map((r) => r.status);
  const bad = statuses.filter((s) => s === 'failed' || s === 'missing' || s === 'not-attempted').length;
  const written = statuses.filter((s) => s === 'written').length;
  if (bad > 0) {
    if (written > 0) return 'partial';
    if (statuses.some((s) => s === 'failed')) return 'failed';
    return 'refused';
  }
  if (written === 0 && statuses.every((s) => s === 'already-recorded')) return 'already-recorded';
  return 'logged';
}

function reportOutcome(command, labelled, outcome, synthetic, extra = '') {
  const parts = labelled.map(([name, r]) => `${name}=${r.status}`);
  // Which protocol serialized this write. Always emitted (and always `flock` for a
  // writer), so a caller - or a harness - can prove which protocol was in force
  // rather than inferring it from the absence of a warning.
  const lockImpl = LOCK_IMPL_IN_FORCE !== 'none' ? LOCK_IMPL_IN_FORCE : process.env.LOEY_LOCK_IMPL_USED || 'none';
  console.log(
    `[heyloey] RESULT ${command} ${outcome} ${parts.join(' ')} lock=${lockImpl} target=${VAULT_DIR} source=${VAULT_TARGET.source}` +
      (synthetic.synthetic ? ` synthetic=${synthetic.reason}` : '') +
      extra
  );
  if (outcome === 'logged') {
    console.log('[heyloey] OK - required record(s) verified on disk.');
  } else if (outcome === 'already-recorded') {
    console.log('[heyloey] OK - nothing to do; required record(s) already contain this entry.');
  } else if (outcome === 'skipped') {
    console.log('[heyloey] NOT LOGGED - explicit synthetic opt-out; no record was touched.');
  } else if (outcome === 'refused') {
    console.error('[heyloey] NOT LOGGED - a required record is absent; nothing was written.');
  } else if (outcome === 'partial') {
    console.error('[heyloey] NOT FULLY LOGGED - partial write; see per-record results above.');
  } else if (outcome === 'failed') {
    console.error('[heyloey] NOT LOGGED - the write failed; no record was changed.');
  }
}

function getGitContext() {
  try {
    const repoPath = execSync('git rev-parse --show-toplevel 2>/dev/null', { encoding: 'utf8' }).trim();
    if (repoPath) {
      const repoName = path.basename(repoPath);
      let branch = '';
      try {
        branch = execSync('git rev-parse --abbrev-ref HEAD 2>/dev/null', { encoding: 'utf8' }).trim();
      } catch (_) {}
      return branch && branch !== 'HEAD' ? `[${repoName}/${branch}] ` : `[${repoName}] `;
    }
  } catch (_) {}
  return '';
}

function getGitRepoName() {
  try {
    const repoPath = execSync('git rev-parse --show-toplevel 2>/dev/null', { encoding: 'utf8' }).trim();
    if (repoPath) return path.basename(repoPath);
  } catch (_) {}
  return path.basename(process.cwd());
}

function cleanMessage(raw) {
  let cleaned = raw.replace(/\r?\n+/g, ' ').trim();
  cleaned = cleaned.replace(/^[-*•\s"']+|["']+$/g, '').trim();
  return cleaned;
}

// Canonical daily-note creation is NOT this CLI's job. The vault owns the daily
// note's frontmatter, focus intentions, Daily Spark quote, tasks and habits
// (99-Templates/Daily.md, or the vault's morning flow). This CLI only ever READS
// today's note. If it is absent we refuse and point at the canonical flow rather
// than fabricating values such as mood, energy, focus intentions, a quote, or
// checked habits. (An earlier revision scaffolded a full note here, which invented
// all of those.)
const DAILY_NOTE_HINT = "create it from 99-Templates/Daily.md (or run the vault's morning flow)";
function dailyNotePath(dateStr, monthDir) {
  return path.join(VAULT_DIR, '01-Daily', monthDir, `${dateStr}.md`);
}

const DAILY_LOG_HEADING = '## 📝 Daily Log';
const LOG_AREA_HEADINGS = {
  personal: '### 🧍 Personal Log',
  agent: '### 🤖 Agent Milestones',
  github: '### 🐙 GitHub Activity'
};
const LOG_AREA_ORDER = ['personal', 'agent', 'github'];

function headingLevel(line) {
  const match = /^(#{1,6})\s/.exec(line.trim());
  return match ? match[1].length : 0;
}

/** The parent daily log: from `## 📝 Daily Log` to the next `##` heading or divider. */
function dailyLogBounds(lines) {
  const start = lines.findIndex((line) => /^## 📝 Daily Log\s*$/.test(line));
  if (start < 0) return null;
  let end = start + 1;
  while (end < lines.length && !/^#{1,2}\s|^---\s*$/.test(lines[end])) end++;
  return { start, end };
}

/** One labelled area inside the parent: its heading and the body up to the next `###` heading. */
function logAreaBounds(lines, area) {
  const parent = dailyLogBounds(lines);
  if (!parent) return null;
  const heading = LOG_AREA_HEADINGS[area];
  let start = -1;
  for (let i = parent.start + 1; i < parent.end; i++) {
    if (lines[i].trim() === heading) {
      start = i;
      break;
    }
  }
  if (start < 0) return null;
  let end = start + 1;
  while (end < parent.end && !/^#{3,}\s/.test(lines[end].trim())) end++;
  return { start, end };
}

/** Insert a heading block, keeping exactly one blank line between it and its neighbours. */
function insertHeading(lines, at, heading) {
  const block = [];
  if (at > 0 && lines[at - 1].trim() !== '') block.push('');
  block.push(heading);
  lines.splice(at, 0, ...block);
  const after = at + block.length;
  if (lines[after] !== undefined && lines[after].trim() !== '') lines.splice(after, 0, '');
  return at + block.length - 1;
}

function ensureLogArea(lines, area) {
  const existing = logAreaBounds(lines, area);
  if (existing) return existing.start;
  const parent = dailyLogBounds(lines);
  if (!parent) return null;
  const heading = LOG_AREA_HEADINGS[area];
  const callout = findAreaCallout(lines, area, parent.start + 1, parent.end);
  if (callout !== -1) return insertHeading(lines, callout, heading);
  if (area === 'personal') {
    let at = parent.start + 1;
    while (at < parent.end && (lines[at].trim() === '' || lines[at].trim().startsWith('>'))) at++;
    return insertHeading(lines, at, heading);
  }
  for (let index = LOG_AREA_ORDER.indexOf(area) + 1; index < LOG_AREA_ORDER.length; index++) {
    const later = logAreaBounds(lines, LOG_AREA_ORDER[index]);
    if (later) return insertHeading(lines, later.start, heading);
  }
  return insertHeading(lines, parent.end, heading);
}

/**
 * Returns the body of a Markdown section, or null when the heading is absent.
 *
 * A section ends at the next heading of the same or a shallower level, so the `###` areas inside
 * `## 📝 Daily Log` (and any deeper heading inside a `###` section) stay part of their parent.
 */
function sectionBody(content, headings) {
  const lines = content.split(/\r?\n/);
  const wanted = Array.isArray(headings) ? headings : [headings];
  for (const heading of wanted) {
    const start = lines.findIndex((l) => l.trim() === heading);
    if (start === -1) continue;
    const level = headingLevel(heading);
    const out = [];
    for (let i = start + 1; i < lines.length; i++) {
      const line = lines[i];
      const lineLevel = headingLevel(line);
      if ((lineLevel > 0 && lineLevel <= level) || line.trim() === '---') break;
      out.push(line);
    }
    return out.join('\n');
  }
  return null;
}

/** Post-write verification: the summary must be inside the daily log section. */
function verifyDailyEntry(filePath, needle) {
  let content;
  try {
    content = fs.readFileSync(filePath, 'utf8');
  } catch (e) {
    return { ok: false, reason: e.message };
  }
  if (!dailyLogBounds(content.split(/\r?\n/))) {
    return { ok: false, reason: '## 📝 Daily Log section missing' };
  }
  if (!logAreaHasSummary(content, 'agent', needle)) {
    return { ok: false, reason: 'entry not found inside ### 🤖 Agent Milestones' };
  }
  return { ok: true };
}

/** Post-write verification: a personal entry must be inside the Personal Log area. */
function verifyPersonalEntry(filePath, needle) {
  let content;
  try {
    content = fs.readFileSync(filePath, 'utf8');
  } catch (e) {
    return { ok: false, reason: e.message };
  }
  if (!dailyLogBounds(content.split(/\r?\n/))) {
    return { ok: false, reason: '## 📝 Daily Log section missing' };
  }
  if (!logAreaHasSummary(content, 'personal', needle)) {
    return { ok: false, reason: 'entry not found inside ### 🧍 Personal Log' };
  }
  return { ok: true };
}

/** Post-write verification: the entry must be inside the Latest Updates section. */
function verifyHandoffEntry(handoffPath, entry) {
  let content;
  try {
    content = fs.readFileSync(handoffPath, 'utf8');
  } catch (e) {
    return { ok: false, reason: e.message };
  }
  const body = sectionBody(content, '### Latest Updates');
  if (body === null) return { ok: false, reason: '### Latest Updates section missing' };
  if (!body.includes(entry)) return { ok: false, reason: 'entry not found inside ### Latest Updates' };
  return { ok: true };
}


function format12hNbsp(time24) {
  const m = String(time24 || '').match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return String(time24 || '');
  let h = parseInt(m[1], 10);
  const min = m[2];
  const ampm = h >= 12 ? 'PM' : 'AM';
  h = h % 12;
  if (h === 0) h = 12;
  return `${String(h).padStart(2, '0')}:${min}&nbsp;${ampm}`;
}

function format12hPlain(time24) {
  return format12hNbsp(time24).replace('&nbsp;', ' ');
}

function splitScopeAndSummary(message) {
  const trimmed = String(message || '').trim();
  const bracketMatch = trimmed.match(/^\[([^\]]+)\]\s*(.*)$/);
  // A scope is recorded only when the caller supplied one. Guessing `loey_space` for a message
  // that arrived without provenance is exactly the inference the separation forbids.
  let scope = '';
  let summary = trimmed;
  if (bracketMatch) {
    const rawScope = bracketMatch[1].trim();
    summary = bracketMatch[2].trim();
    const slashIdx = rawScope.indexOf('/');
    if (slashIdx !== -1) {
      const repo = rawScope.slice(0, slashIdx);
      const branch = rawScope.slice(slashIdx + 1);
      scope = `\`${repo}\` (\`${branch}\`)`;
    } else {
      scope = `\`${rawScope}\``;
    }
  }
  return { scope, summary };
}

function tableCellsOf(line) {
  const match = String(line).match(/^(?:>\s*)?\|(.*)\|\s*$/);
  if (!match) return null;
  const cells = [];
  let cell = '';
  let escaped = false;
  for (const char of match[1]) {
    if (escaped) {
      cell += char;
      escaped = false;
    } else if (char === '\\') {
      cell += char;
      escaped = true;
    } else if (char === '|') {
      cells.push(cell);
      cell = '';
    } else {
      cell += char;
    }
  }
  cells.push(cell);
  return cells;
}

function unescapeCell(cell) {
  return String(cell).replace(/\\\|/g, '|').replace(/&lt;/g, '<').replace(/&amp;/g, '&').trim();
}

function escapeCell(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/\|/g, '\\|')
    .replace(/<(?!br\s*\/?>)(?=[a-zA-Z/])/gi, '&lt;')
    .replace(/\r?\n/g, ' ')
    .trim();
}

function tableTime(stamp) {
  const minutes = minuteOfDay(stamp);
  if (minutes === null) return String(stamp);
  const hour = String(Math.floor(minutes / 60)).padStart(2, '0');
  const minute = String(minutes % 60).padStart(2, '0');
  return format12hNbsp(`${hour}:${minute}`);
}

function isSeparatorRow(cells) {
  return Array.isArray(cells) && cells.length > 0 && cells.every((cell) => /^:?-{3,}:?$/.test(String(cell).trim()));
}

function readAgentTableRow(line) {
  const cells = tableCellsOf(line);
  if (!cells || cells.length < 3) return null;
  if (minuteOfDay(cells[0].replace(/&nbsp;/g, ' ')) === null) return null;
  return {
    stamp: cells[0].trim(),
    scope: unescapeCell(cells[1]),
    summary: unescapeCell(cells.slice(2).join(' | '))
  };
}

/** The body of one labelled area, or null when the area is absent. */
function logAreaBody(lines, area) {
  const bounds = logAreaBounds(lines, area);
  if (!bounds) return null;
  return lines.slice(bounds.start + 1, bounds.end).join('\n');
}

/**
 * Area-scoped duplicate detection. A personal entry that happens to share wording with an agent
 * milestone is a different record, and must neither suppress nor be suppressed by it.
 */
function logAreaHasSummary(content, area, summary) {
  const lines = content.split(/\r?\n/);
  const body = logAreaBody(lines, area);
  if (body === null) return false;
  const needle = unescapeCell(summary);
  for (const line of body.split(/\r?\n/)) {
    const row = readAgentTableRow(line);
    if (row && row.summary.includes(needle)) return true;
    const bullet = line.match(/^- \*\*(?:\[)?([^\]*]+?)(?:\])?\*\*(?::|\s)\s*(.*)$/);
    if (bullet && unescapeCell(bullet[2]).includes(needle)) return true;
  }
  return false;
}

const AGENT_TABLE_HEADER = ['| Time | Scope | Milestone |', '| :--- | :--- | :--- |'];

/**
 * The one collapsible container for the agent area. The area heading plus this single toggle is the
 * whole presentation: the table is quoted inside the callout, so it stays folded until asked for,
 * and there is no second title, no parallel bullet list and no competing table.
 */
function agentCalloutLabel(count) {
  return `> [!NOTE]- 🤖 Show entries (${count})`;
}

const AGENT_CALLOUT = /^> \[!NOTE\]-\s*🤖\s*Show entries/;
const LEGACY_AGENT_CALLOUT = /^> \[!NOTE\]-\s*🤖 Agent Milestone Log/;

/** The callout a logging tool already writes for each area, wherever an older write left it. */
const AREA_CALLOUT = {
  personal: /^> \[!NOTE\]-\s*🧍/,
  agent: /^> \[!NOTE\]-\s*🤖(?:\s+Show entries|\s+Agent Milestone Log)/,
  github: /^> \[!NOTE\]-\s*🐙 GitHub Activity Log/
};

/** The first index of an area's own callout inside [from, to), or -1. */
function findAreaCallout(lines, area, from, to) {
  for (let i = from; i < to; i += 1) if (AREA_CALLOUT[area].test(lines[i].trim())) return i;
  return -1;
}

/** A callout block: its header line, every quoted line under it, and one trailing blank line. */
function calloutBlockEnd(lines, start, limit) {
  let end = start + 1;
  while (end < limit && /^\s*>/.test(lines[end])) end += 1;
  if (end < limit && lines[end].trim() === '') end += 1;
  return end;
}

/**
 * Move an area's own callout under its heading when an earlier write left it in another area.
 * A positional move only: not one of its lines is rewritten.
 */
function adoptAreaCallout(lines, area) {
  const parent = dailyLogBounds(lines);
  if (!parent) return false;
  const heading = logAreaBounds(lines, area);
  if (!heading) return false;
  const start = findAreaCallout(lines, area, parent.start + 1, parent.end);
  if (start === -1) return false;
  if (start > heading.start && start < heading.end) return false;
  const block = lines.splice(start, calloutBlockEnd(lines, start, parent.end) - start);
  while (block.length > 1 && block[block.length - 1].trim() === '') block.pop();
  const target = logAreaBounds(lines, area);
  if (!target) return false;
  let at = target.end;
  while (at > target.start + 1 && lines[at - 1].trim() === '') at -= 1;
  const insert = [...block];
  if (at > 0 && lines[at - 1].trim() !== '') insert.unshift('');
  if (lines[at] !== undefined && lines[at].trim() !== '') insert.push('');
  lines.splice(at, 0, ...insert);
  return true;
}

/** Give every callout already present the area heading it belongs under; returns how many moved. */
function adoptCalloutAreas(lines) {
  let adopted = 0;
  for (const area of LOG_AREA_ORDER) {
    const parent = dailyLogBounds(lines);
    if (!parent) break;
    if (findAreaCallout(lines, area, parent.start + 1, parent.end) === -1) continue;
    if (!logAreaBounds(lines, area)) ensureLogArea(lines, area);
    if (adoptAreaCallout(lines, area)) adopted += 1;
  }
  return adopted;
}

function quoted(line) {
  return `> ${line}`;
}

/** The agent area's single container: its toggle, the end of the quoted block and its header row. */
function findAgentContainer(lines) {
  const area = logAreaBounds(lines, 'agent');
  const container = { area: area || null, start: -1, end: -1, header: -1 };
  if (!area) return container;
  for (let index = area.start + 1; index < area.end; index++) {
    if (!AGENT_CALLOUT.test(lines[index].trim())) continue;
    container.start = index;
    container.end = index + 1;
    while (container.end < area.end && /^>/.test(lines[container.end].trim())) container.end++;
    for (let row = index + 1; row < container.end; row++) {
      const cells = tableCellsOf(lines[row]);
      if (cells && /^time$/i.test(String(cells[0]).trim())) {
        container.header = row;
        break;
      }
    }
    return container;
  }
  return container;
}

function countAgentRows(lines, container) {
  if (container.header === -1) return 0;
  let count = 0;
  for (let index = container.header + 1; index < container.end; index++) {
    if (readAgentTableRow(lines[index])) count++;
  }
  return count;
}

/** Stable chronological sort of the area's one table, wherever it is currently kept. */
function sortAgentTable(lines) {
  const container = findAgentContainer(lines);
  const area = container.area || logAreaBounds(lines, 'agent');
  if (!area) return;
  const limit = container.start !== -1 ? container.end : area.end;
  let header = container.header;
  if (header === -1) {
    for (let index = area.start + 1; index < limit; index++) {
      const cells = tableCellsOf(lines[index]);
      if (cells && /^time$/i.test(String(cells[0]).trim())) {
        header = index;
        break;
      }
    }
  }
  if (header === -1) return;
  if (container.start !== -1) {
    let separator = -1;
    for (let index = container.start + 1; index < container.end; index++) {
      if (isSeparatorRow(tableCellsOf(lines[index]))) { separator = index; break; }
    }
    if (separator !== -1 && (header !== container.start + 1 || separator !== header + 1)) {
      const structure = [lines[header], lines[separator]];
      for (const index of [header, separator].sort((left, right) => right - left)) lines.splice(index, 1);
      lines.splice(container.start + 1, 0, ...structure);
      header = container.start + 1;
    }
    lines[container.start] = agentCalloutLabel(countAgentRows(lines, { ...container, header }));
  }
  let first = header + 1;
  if (isSeparatorRow(tableCellsOf(lines[first] || ''))) first++;
  let end = first;
  while (end < limit && readAgentTableRow(lines[end])) end++;
  if (end - first < 2) return;
  const rows = lines.slice(first, end);
  rows.sort((left, right) => minuteOfDay(unescapeCell(tableCellsOf(left)[0])) - minuteOfDay(unescapeCell(tableCellsOf(right)[0])));
  lines.splice(first, end - first, ...rows);
}

/** Append rows to the area's one table, creating the collapsible container when it is absent. */
function appendAgentRows(lines, rows, preferredAt = -1) {
  ensureLogArea(lines, 'agent');
  let area = logAreaBounds(lines, 'agent');
  if (!area) return;
  let container = findAgentContainer(lines);

  if (container.start === -1) {
    const anchor = preferredAt > area.start && preferredAt < area.end ? preferredAt : area.start + 1;
    const block = [agentCalloutLabel(rows.length), ...AGENT_TABLE_HEADER.map(quoted), ...rows.map(quoted)];
    if (anchor > 0 && lines[anchor - 1].trim() !== '') block.unshift('');
    lines.splice(anchor, 0, ...block);
    // Exactly one blank line after the container, whatever spacing the line it displaced left.
    let after = anchor + block.length;
    while (after < lines.length && lines[after].trim() === '') after += 1;
    const blanks = after - (anchor + block.length);
    if (blanks === 0) lines.splice(after, 0, '');
    else if (blanks > 1) lines.splice(anchor + block.length, blanks - 1);
  } else if (container.header === -1) {
    lines.splice(container.start + 1, 0, ...AGENT_TABLE_HEADER.map(quoted), ...rows.map(quoted));
  } else {
    let end = container.end;
    while (end > container.header + 1 && !readAgentTableRow(lines[end - 1])) end--;
    const separator = tableCellsOf(lines[container.header + 1] || '');
    const firstData = container.header + (isSeparatorRow(separator) ? 2 : 1);
    lines.splice(Math.max(end, firstData), 0, ...rows.map(quoted));
  }

  area = logAreaBounds(lines, 'agent');
  container = findAgentContainer(lines);
  if (container.start !== -1 && area) {
    lines[container.start] = agentCalloutLabel(countAgentRows(lines, container));
    if (container.end < area.end && lines[container.end] && lines[container.end].trim() !== '') {
      lines.splice(container.end, 0, '');
    }
  }
  sortAgentTable(lines);
}


/**
 * Convert the agent area's previous representations into rows: timestamped bullets and the plain
 * (unquoted) table of the earlier layout. Text that is not a timestamped entry is left untouched.
 */
function convertAgentAreaBullets(lines) {
  const area = logAreaBounds(lines, 'agent');
  if (!area) return 0;
  const rows = [];
  const remove = [];
  let anchor = -1;
  // Everything the one container already holds is that container's business: it is current format,
  // and re-reading it here would duplicate rows and strand a separator line.
  const container = findAgentContainer(lines);
  const owned = (index) => container.start !== -1 && index >= container.start && index < container.end;
  for (let i = area.start + 1; i < area.end; i++) {
    if (owned(i)) {
      i = container.end - 1;
      continue;
    }
    if (LEGACY_AGENT_CALLOUT.test(lines[i].trim())) {
      const end = calloutBlockEnd(lines, i, area.end);
      for (let j = i + 1; j < end; j++) {
        const parsed = readAgentTableRow(lines[j]);
        if (parsed) {
          rows.push(`| ${tableTime(parsed.stamp)} | ${parsed.scope ? escapeCell(parsed.scope) : ''} | ${escapeCell(parsed.summary)} |`);
        }
      }
      if (anchor === -1) anchor = i;
      for (let j = i; j < end; j++) remove.push(j);
      i = end - 1;
      continue;
    }
    const row = readAgentTableRow(lines[i]);
    if (row) {
      rows.push(`| ${tableTime(row.stamp)} | ${row.scope ? escapeCell(row.scope) : ''} | ${escapeCell(row.summary)} |`);
      if (anchor === -1) anchor = i;
      remove.push(i);
      continue;
    }
    const cells = tableCellsOf(lines[i]);
    if (cells && /^time$/i.test(String(cells[0]).trim())) {
      if (anchor === -1) anchor = i;
      remove.push(i);
      let cursor = i + 2;
      while (cursor < area.end && readAgentTableRow(lines[cursor])) cursor++;
      for (let j = i + 2; j < cursor; j++) {
        const parsed = readAgentTableRow(lines[j]);
        if (parsed) {
          rows.push(`| ${tableTime(parsed.stamp)} | ${parsed.scope ? escapeCell(parsed.scope) : ''} | ${escapeCell(parsed.summary)} |`);
        }
        remove.push(j);
      }
      i = cursor - 1;
      continue;
    }
    const match = lines[i].match(/^- \*\*(?:\[)?([^\]*]+?)(?:\])?\*\*(?::|\s)\s*(.*)$/);
    if (!match || minuteOfDay(match[1]) === null) continue;
    let summary = match[2].trim();
    let cursor = i + 1;
    const continuation = [];
    while (cursor < area.end && /^(?: {2,}|\t)\S/.test(lines[cursor])) continuation.push(lines[cursor++].trim());
    if (continuation.length) summary += '<br>' + continuation.join('<br>');
    rows.push(`| ${tableTime(match[1])} |  | ${escapeCell(summary)} |`);
    if (anchor === -1) anchor = i;
    for (let j = i; j < cursor; j++) remove.push(j);
    i = cursor - 1;
  }
  if (!rows.length) return 0;
  const unique = [...new Set(remove)].sort((a, b) => b - a);
  for (const index of unique) lines.splice(index, 1);
  ensureLogArea(lines, 'agent');
  appendAgentRows(lines, rows, anchor);
  return rows.length;
}

/** One timestamped log bullet's stamp and summary, in either bullet form the log uses. */
function readLogEntry(line) {
  const match = line.match(/^- \*\*(?:\[)?([^\]*]+?)(?:\])?\*\*(?::\s*|\s+)(.*)$/);
  if (!match) return null;
  const stamp = match[1].trim();
  if (minuteOfDay(stamp) === null) return null;
  return { stamp, summary: match[2].trim() };
}

/** Timestamped bullets inside one area, with their continuation lines. */
function timedBlocks(lines, bounds) {
  const blocks = [];
  for (let index = bounds.start + 1; index < bounds.end; index += 1) {
    const entry = readLogEntry(lines[index]);
    if (!entry) continue;
    let cursor = index + 1;
    while (cursor < bounds.end && /^(?: {2,}|\t)\S/.test(lines[cursor])) cursor += 1;
    blocks.push({
      start: index,
      end: cursor,
      stamp: entry.stamp,
      summary: entry.summary,
      continuation: lines
        .slice(index + 1, cursor)
        .map((line) => line.trim())
        .filter(Boolean)
        .join('<br>')
    });
    index = cursor - 1;
  }
  return blocks;
}

function migrationRow(block) {
  const summary = escapeCell(block.continuation ? `${block.summary}<br>${block.continuation}` : block.summary);
  return `| ${displayLogTime(block.stamp, '&nbsp;')} |  | ${summary} |`;
}

/** Entries inside one area: timestamped bullets and agent-table rows. */
function logAreaEntries(content, area) {
  const newline = content.includes('\r\n') ? '\r\n' : '\n';
  const lines = content.split(newline);
  const bounds = logAreaBounds(lines, area);
  if (!bounds) return [];
  const entries = [];
  for (let index = bounds.start + 1; index < bounds.end; index += 1) {
    const bullet = readLogEntry(lines[index]);
    if (bullet) {
      entries.push({ stamp: bullet.stamp, scope: '', summary: bullet.summary });
      continue;
    }
    const row = readAgentTableRow(lines[index]);
    if (row) entries.push(row);
  }
  return entries;
}

/** Drop the blank spacer directly under an area heading once the area carries entries. */
function tidyAreaSpacer(lines, area) {
  const body = logAreaBounds(lines, area);
  if (!body) return;
  let spacer = body.start + 1;
  while (spacer < body.end && lines[spacer].trim() === '') spacer += 1;
  if (spacer === body.start + 1) return;
  if (!lines.slice(spacer, body.end).some((entry) => /^\s*-\s+\S/.test(entry))) return;
  lines.splice(body.start + 1, spacer - body.start - 1);
}

/**
 * Put one daily note into its canonical shape without guessing authorship.
 *
 * Format migration is automatic: every labelled area is created, agent bullets and any legacy
 * `Agent Milestone Log` callout become the area's one table. A personal entry moves into that
 * table ONLY when the caller names it with --select or --select-summary. No verb, capitalisation
 * or tone is treated as evidence, so an ambiguous or unmatched selection writes nothing.
 */
function migrateAgentMilestones(content, selection = {}) {
  const newline = content.includes('\r\n') ? '\r\n' : '\n';
  const lines = content.split(newline);
  if (!dailyLogBounds(lines)) {
    return { content, moved: [], kept: [], adopted: 0, selectionErrors: [], ok: false };
  }

  for (const area of LOG_AREA_ORDER) ensureLogArea(lines, area);
  const adopted = adoptCalloutAreas(lines);

  const personal = logAreaBounds(lines, 'personal');
  const blocks = personal ? timedBlocks(lines, personal) : [];
  const chosen = new Map();
  const selectionErrors = [];

  const select = (label, matches) => {
    const already = matches.filter((block) => chosen.has(block.start));
    if (matches.length > 0 && already.length === matches.length) return;
    if (matches.length === 0) {
      selectionErrors.push(`${label} matches no timestamped personal entry`);
      return;
    }
    if (matches.length > 1) {
      selectionErrors.push(`${label} matches ${matches.length} personal entries; name one`);
      return;
    }
    chosen.set(matches[0].start, matches[0]);
  };

  for (const stamp of selection.selectStamps || []) {
    const minutes = minuteOfDay(stamp);
    if (minutes === null) {
      selectionErrors.push(`--select "${stamp}" is not a time (use e.g. "09:21 AM")`);
      continue;
    }
    select(`--select "${stamp}"`, blocks.filter((block) => minuteOfDay(block.stamp) === minutes));
  }
  for (const text of selection.selectSummaries || []) {
    const needle = text.trim();
    if (!needle) {
      selectionErrors.push('--select-summary requires some text');
      continue;
    }
    select(`--select-summary "${needle}"`, blocks.filter((block) => block.summary.includes(needle)));
  }

  if (selectionErrors.length > 0) {
    return {
      content,
      moved: [],
      kept: blocks.map((block) => block.summary),
      adopted: 0,
      selectionErrors,
      ok: true
    };
  }

  const ordered = [...chosen.values()].sort((left, right) => left.start - right.start);
  for (let index = ordered.length - 1; index >= 0; index -= 1) {
    const block = ordered[index];
    lines.splice(block.start, block.end - block.start);
  }

  convertAgentAreaBullets(lines);
  if (ordered.length > 0) appendAgentRows(lines, ordered.map(migrationRow));

  for (const area of LOG_AREA_ORDER) tidyAreaSpacer(lines, area);
  const migrated = normalizeDailyLog(lines.join(newline));
  return {
    content: migrated,
    moved: ordered.map((block) => block.summary),
    kept: logAreaEntries(migrated, 'personal').map((entry) => entry.summary),
    adopted,
    selectionErrors: [],
    ok: true
  };
}

/** `migrate-log` flags: repeated selections, an optional date and a dry run. */
function parseMigrateArgs(tokens) {
  const parsed = { date: null, select: [], selectSummaries: [], dryRun: false, errors: [] };
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === '--dry-run') {
      parsed.dryRun = true;
      continue;
    }
    if (token === '--date' || token === '--select' || token === '--select-summary') {
      const value = tokens[index + 1];
      if (value === undefined || value.startsWith('--')) {
        parsed.errors.push(`${token} requires a value`);
        continue;
      }
      if (token === '--date') parsed.date = value;
      else if (token === '--select') parsed.select.push(value);
      else parsed.selectSummaries.push(value);
      index += 1;
      continue;
    }
    parsed.errors.push(`unexpected argument: ${token}; use --date <YYYY-MM-DD>`);
  }
  return parsed;
}

function insertAgentTableRow(content, timeStr, message) {
  const { scope, summary } = splitScopeAndSummary(message);
  const lines = content.split('\n');

  if (!dailyLogBounds(lines)) {
    return (
      `${content.trimEnd()}\n\n${DAILY_LOG_HEADING}\n> _A running timestamp of what happened today._\n\n` +
      `${LOG_AREA_HEADINGS.personal}\n\n${LOG_AREA_HEADINGS.agent}\n\n` +
      `${agentCalloutLabel(1)}\n${AGENT_TABLE_HEADER.map(quoted).join('\n')}\n` +
      `> | ${format12hNbsp(timeStr)} | ${scope ? escapeCell(scope) : ''} | ${escapeCell(summary)} |\n\n` +
      `${LOG_AREA_HEADINGS.github}\n`
    );
  }

  // One container, whatever the note arrived with: adopt a stranded legacy callout, fold bullets or
  // the previous plain table into rows, then append the new row to the table that is now there.
  ensureLogArea(lines, 'agent');
  adoptCalloutAreas(lines);
  convertAgentAreaBullets(lines);
  appendAgentRows(lines, [
    `| ${format12hNbsp(timeStr)} | ${scope ? escapeCell(scope) : ''} | ${escapeCell(summary)} |`,
  ]);
  return lines.join('\n');
}

/** Personal entries are owner bullets, never table rows and never a scope-inferred agent event. */
function insertPersonalBullet(content, timeStr, message) {
  const lines = content.split('\n');
  if (!dailyLogBounds(lines)) return content;
  ensureLogArea(lines, 'personal');
  let area = logAreaBounds(lines, 'personal');
  if (!area) return content;
  for (let i = area.end - 1; i > area.start; i--) {
    if (lines[i].trim() === '-') {
      lines.splice(i, 1);
      i++;
    }
  }
  area = logAreaBounds(lines, 'personal');
  const bullet = `- **${format12hPlain(timeStr)}**: ${cleanMessage(message)}`;
  let insertAt = area.start + 1;
  for (let i = area.start + 1; i < area.end; i++) {
    if (!/^- \*\*(?:\[)?[^\]*]+(?:\])?\*\*(?::|\s)/.test(lines[i])) continue;
    insertAt = i + 1;
    while (insertAt < area.end && /^(?: {2,}|\t)\S/.test(lines[insertAt])) insertAt++;
  }
  lines.splice(insertAt, 0, bullet);
  return lines.join('\n');
}

function logToDailyNote(message, synthetic = detectSynthetic()) {
  const { dateStr, monthDir, timeStr } = getTodayInfo();
  const filePath = dailyNotePath(dateStr, monthDir);
  const rel = vaultRel(filePath);

  if (synthetic.synthetic) {
    console.log(`[heyloey] SKIPPED daily note - explicit synthetic opt-out (${synthetic.reason}); nothing written.`);
    return { status: 'skipped', path: rel, detail: `synthetic opt-out (${synthetic.reason})` };
  }

  if (!fs.existsSync(filePath)) {
    console.error(`[heyloey] REFUSED daily note: ${rel} is absent - ${DAILY_NOTE_HINT}; nothing written.`);
    return { status: 'missing', path: rel, detail: 'daily note absent' };
  }

  try {
    let content = fs.readFileSync(filePath, 'utf8');
    const { summary } = splitScopeAndSummary(message);

    // Only the agent area counts: an owner's personal entry with the same words is a different
    // record and must not make this automated milestone look already logged.
    if (logAreaHasSummary(content, 'agent', summary)) {
      console.log(`[heyloey] ALREADY-RECORDED daily note: ${rel} (entry already present in the agent area)`);
      return { status: 'already-recorded', path: rel, detail: 'entry already present in the agent area' };
    }

    content = normalizeDailyLog(insertAgentTableRow(content, timeStr, message));
    atomicWriteFileSync(filePath, content);

    // Confirm the entry landed inside the agent area before claiming a write.
    const check = verifyDailyEntry(filePath, summary.length > 0 ? summary : message);
    if (!check.ok) {
      console.error(`[heyloey] FAILED daily note: ${rel} - post-write verification: ${check.reason}`);
      return { status: 'failed', path: rel, detail: `post-write verification: ${check.reason}` };
    }
    console.log(`[heyloey] LOGGED daily note: ${rel} (${timeStr})`);
    return { status: 'written', path: rel, detail: `entry added (${timeStr})` };
  } catch (e) {
    console.error(`[heyloey] FAILED daily note: ${rel} - ${e.message}`);
    return { status: 'failed', path: rel, detail: e.message };
  }
}

function logToPersonal(message, synthetic = detectSynthetic()) {
  const { dateStr, monthDir, timeStr } = getTodayInfo();
  const filePath = dailyNotePath(dateStr, monthDir);
  const rel = vaultRel(filePath);

  if (synthetic.synthetic) {
    console.log(`[heyloey] SKIPPED daily note - explicit synthetic opt-out (${synthetic.reason}); nothing written.`);
    return { status: 'skipped', path: rel, detail: `synthetic opt-out (${synthetic.reason})` };
  }
  if (!fs.existsSync(filePath)) {
    console.error(`[heyloey] REFUSED daily note: ${rel} is absent - ${DAILY_NOTE_HINT}; nothing written.`);
    return { status: 'missing', path: rel, detail: 'daily note absent' };
  }

  try {
    let content = fs.readFileSync(filePath, 'utf8');
    const summary = cleanMessage(message);
    if (logAreaHasSummary(content, 'personal', summary)) {
      console.log(`[heyloey] ALREADY-RECORDED daily note: ${rel} (entry already present in the personal area)`);
      return { status: 'already-recorded', path: rel, detail: 'entry already present in the personal area' };
    }
    content = normalizeDailyLog(insertPersonalBullet(content, timeStr, summary));
    atomicWriteFileSync(filePath, content);
    const check = verifyPersonalEntry(filePath, summary);
    if (!check.ok) {
      console.error(`[heyloey] FAILED daily note: ${rel} - post-write verification: ${check.reason}`);
      return { status: 'failed', path: rel, detail: `post-write verification: ${check.reason}` };
    }
    console.log(`[heyloey] LOGGED personal note: ${rel} (${timeStr})`);
    return { status: 'written', path: rel, detail: `entry added (${timeStr})` };
  } catch (e) {
    console.error(`[heyloey] FAILED personal note: ${rel} - ${e.message}`);
    return { status: 'failed', path: rel, detail: e.message };
  }
}

function archiveHandoffOverflow(overflowLines, monthDir, dateStr) {
  if (!overflowLines || overflowLines.length === 0) return 0;
  const archiveDir = path.join(VAULT_DIR, '07-Reviews');
  if (!fs.existsSync(archiveDir)) {
    fs.mkdirSync(archiveDir, { recursive: true });
  }
  const archivePath = path.join(archiveDir, `handoff-archive-${monthDir}.md`);
  let archiveContent = '';
  if (fs.existsSync(archivePath)) {
    archiveContent = fs.readFileSync(archivePath, 'utf8');
  } else {
    archiveContent = `---
title: "Handoff Archive (${monthDir})"
type: review
kind: archive
area: system
status: archived
created: ${dateStr}
updated: ${dateStr}
tags:
  - type/review
  - area/system
---

# 🗄️ Handoff Milestones Archive (${monthDir})

> Automatically pruned from \`handoff.md\` (\`### Latest Updates\`) by \`heyloey\` to keep active session handoff under 1,500 tokens.

## 📜 Archived Updates
`;
  }

  let added = 0;
  for (const line of overflowLines) {
    if (!archiveContent.includes(line.trim())) {
      archiveContent += `${line.trim()}\n`;
      added++;
    }
  }
  archiveContent = archiveContent.replace(/updated: \d{4}-\d{2}-\d{2}/, () => `updated: ${dateStr}`);
  atomicWriteFileSync(archivePath, archiveContent);
  return added;
}

function pruneHandoffContent(content, maxUpdates = MAX_HANDOFF_UPDATES) {
  const { dateStr, monthDir } = getTodayInfo();
  const sectionRegex = /(### Latest Updates[ \t]*\r?\n)([\s\S]*?)(?=\r?\n### |\r?\n## |\r?\n---|$)/;
  const match = content.match(sectionRegex);
  if (!match) return { content, prunedCount: 0 };

  const header = match[1];
  const body = match[2];
  const lines = body.split(/\r?\n/);

  const bulletLines = [];
  const otherLines = [];
  for (const line of lines) {
    if (/^\s*-\s*\[[xX]\]\s+/.test(line)) {
      bulletLines.push(line);
    } else if (line.trim() !== '') {
      otherLines.push(line);
    }
  }

  if (bulletLines.length <= maxUpdates) {
    return { content, prunedCount: 0 };
  }

  const kept = bulletLines.slice(0, maxUpdates);
  const overflow = bulletLines.slice(maxUpdates);
  archiveHandoffOverflow(overflow, monthDir, dateStr);

  const rebuiltBody = '\n' + [...kept, ...otherLines].join('\n') + '\n';
  // Callback form: `rebuiltBody` carries user text, so dollar-tokens stay literal.
  const updatedContent = content.replace(sectionRegex, (match, head) => `${head}${rebuiltBody}`);
  return { content: updatedContent, prunedCount: overflow.length };
}

function updateHandoff(message, synthetic = detectSynthetic()) {
  const handoffPath = path.join(VAULT_DIR, 'handoff.md');
  const rel = vaultRel(handoffPath);
  const { dateStr, timeStr } = getTodayInfo();

  if (synthetic.synthetic) {
    console.log(`[heyloey] SKIPPED handoff - explicit synthetic opt-out (${synthetic.reason}); nothing written.`);
    return { status: 'skipped', path: rel, detail: `synthetic opt-out (${synthetic.reason})` };
  }

  if (!fs.existsSync(handoffPath)) {
    console.error(`[heyloey] REFUSED handoff: ${rel} is absent (create it with \`npm run init:vault\`); nothing written.`);
    return { status: 'missing', path: rel, detail: 'handoff.md absent' };
  }

  try {
    let content = fs.readFileSync(handoffPath, 'utf8');

    if (content.includes(message)) {
      console.log(`[heyloey] ALREADY-RECORDED handoff: ${rel} (entry already present)`);
      return { status: 'already-recorded', path: rel, detail: 'entry already present' };
    }

    const entry = `- [x] **[${dateStr} ${timeStr}]** ${message}`;

    if (/### Latest Updates[^\n]*\n/.test(content)) {
      // Callback form: `entry` carries user text, so `$&`, `$$`, `$'`, "`$`" and `$1`
      // must be preserved literally instead of being expanded as replacement patterns.
      content = content.replace(/(### Latest Updates[^\n]*\n(?:\r?\n)?)/, (match, head) => `${head}${entry}\n`);
    } else if (content.includes("## 📋 Today's Immediate Next Actions")) {
      content = content.replace("## 📋 Today's Immediate Next Actions", () => `## 📋 Today's Immediate Next Actions\n${entry}`);
    } else {
      content += `\n\n### Latest Updates\n\n${entry}\n`;
    }

    const pruned = pruneHandoffContent(content, MAX_HANDOFF_UPDATES);
    content = pruned.content;
    content = content.replace(/updated: \d{4}-\d{2}-\d{2}/, () => `updated: ${dateStr}`);

    atomicWriteFileSync(handoffPath, content);

    // Confirm the entry is inside ### Latest Updates before claiming a write.
    const check = verifyHandoffEntry(handoffPath, entry);
    if (!check.ok) {
      console.error(`[heyloey] FAILED handoff: ${rel} - post-write verification: ${check.reason}`);
      return { status: 'failed', path: rel, detail: `post-write verification: ${check.reason}` };
    }
    const pruneNote = pruned.prunedCount > 0 ? ` [auto-archived ${pruned.prunedCount} older item(s)]` : '';
    console.log(`[heyloey] LOGGED handoff: ${rel} (${dateStr} ${timeStr})${pruneNote}`);
    return { status: 'written', path: rel, detail: `entry added (${dateStr} ${timeStr})${pruneNote}` };
  } catch (e) {
    console.error(`[heyloey] FAILED handoff: ${rel} - ${e.message}`);
    return { status: 'failed', path: rel, detail: e.message };
  }
}

function stripFrontmatterAndCode(md) {
  return md
    .replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '')
    .replace(/```dataview(?:js)?[\s\S]*?```/g, '')
    .replace(/^[ \t]*>[ \t]*.*$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function findStaleTasksInContent(dailyContent, handoffContent, todayDate) {
  const stale = [];
  const dateRegex = /(?:📅|created:)\s*(\d{4}-\d{2}-\d{2})/;
  const todayMs = new Date(todayDate).getTime();

  function checkLine(line) {
    const trimmed = line.trim();
    if (!/^- \[[ \/]\] /.test(trimmed)) return;
    const match = trimmed.match(dateRegex);
    if (!match) return;
    const taskDate = match[1];
    const taskMs = new Date(taskDate).getTime();
    if (isNaN(taskMs)) return;
    const days = Math.floor((todayMs - taskMs) / (1000 * 60 * 60 * 24));
    if (days >= 7) {
      const clean = trimmed
        .replace(/^- \[[ \/]\]\s*/, '')
        .replace(dateRegex, '')
        .trim();
      const snippet = clean.length > 40 ? clean.slice(0, 37) + '...' : clean;
      stale.push({ text: snippet, days });
    }
  }

  if (dailyContent) {
    for (const line of dailyContent.split(/\r?\n/)) checkLine(line);
  }
  if (handoffContent) {
    for (const line of handoffContent.split(/\r?\n/)) checkLine(line);
  }
  return stale;
}

function generateBrief(includeKiwiSoul = false) {
  const { dateStr, monthDir } = getTodayInfo();
  const memPath = path.join(VAULT_DIR, 'memory.md');
  const handoffPath = path.join(VAULT_DIR, 'handoff.md');
  const dailyPath = path.join(VAULT_DIR, '01-Daily', monthDir, `${dateStr}.md`);
  const soulPath = path.join(VAULT_DIR, '00-Private', 'SOUL.md');

  const out = [];
  out.push(`=== LOEY_SPACE CONDENSED BRIEF (${dateStr}) ===`);

  if (fs.existsSync(memPath)) {
    const mem = fs.readFileSync(memPath, 'utf8');
    const invariants = [];
    const bridges = [];
    let section = '';
    for (const line of mem.split(/\r?\n/)) {
      if (line.startsWith('## ')) section = line;
      else if (section.includes('Invariants') && /^\d+\./.test(line.trim())) {
        invariants.push(line.trim().replace(/\*\*([^*]+)\*\*:\s*/, '$1: '));
      } else if (section.includes('Project Pointers') && line.trim().startsWith('|') && !line.includes('---') && !line.includes('Repository bridge')) {
        bridges.push(line.trim());
      } else if (section.includes('Shell Invariants') && line.trim().startsWith('- ')) {
        invariants.push(line.trim());
      }
    }
    out.push('\n[MEMORY INVARIANTS & BRIDGES]');
    invariants.forEach((l) => out.push(l));
    bridges.forEach((l) => out.push(l));
  }

  if (fs.existsSync(handoffPath)) {
    const ho = fs.readFileSync(handoffPath, 'utf8');
    out.push('\n[HANDOFF: OBJECTIVES & LATEST 5 UPDATES]');
    let section = '';
    let updatesCount = 0;
    for (const line of ho.split(/\r?\n/)) {
      if (line.startsWith('## ') || line.startsWith('### ')) {
        section = line.trim();
        continue;
      }
      const t = line.trim();
      if (!t || t.startsWith('>') || t.startsWith('---') || t.startsWith('*Note:')) continue;
      if (section.includes('Current Main Objectives')) {
        out.push(t);
      } else if (section.includes('Latest Updates') && t.startsWith('- [x]')) {
        if (updatesCount < 5) {
          out.push(t);
          updatesCount++;
        }
      } else if (section.includes('Immediate Next Moves') && t.startsWith('- [ ]')) {
        out.push(`NEXT: ${t}`);
      } else if (section.includes('Active Blockers') && t.startsWith('- ')) {
        out.push(`BLOCKER: ${t}`);
      }
    }
  }

  if (fs.existsSync(dailyPath)) {
    const daily = fs.readFileSync(dailyPath, 'utf8');
    const tasks = [];
    const logs = [];
    const habits = [];
    let section = '';
    for (const line of daily.split(/\r?\n/)) {
      if (line.startsWith('#')) {
        section = line.trim();
        continue;
      }
      const t = line.trim();
      if (section.includes('Tasks') && /^- \[[ \/]\] \S+/.test(t)) {
        tasks.push(t);
      } else if (section.includes('Daily Log')) {
        if (t.startsWith('- ') && t.length > 2) {
          logs.push(t);
        } else if (t.startsWith('> |') && !t.includes('| Time |') && !t.includes(':---')) {
          const cells = t.replace(/^>\s*\|?/, '').replace(/\|?\s*$/, '').split(/(?<!\\)\|/).map((c) => c.trim());
          if (cells.length >= 3 && !cells[2].startsWith('🐙') && !cells[2].startsWith('🔀') && !cells[2].startsWith('🎯')) {
            const cleanTime = cells[0].replace(/&nbsp;/g, ' ');
            logs.push(`- **${cleanTime}**: [${cells[1].replace(/`/g, '')}] ${cells[2]}`);
          }
        }
      } else if (includeKiwiSoul && section.includes('Habits') && t.startsWith('- [')) {
        habits.push(t);
      }
    }
    out.push(`\n[TODAY (${dateStr}): ACTIVE TASKS & RECENT LOGS]`);
    if (tasks.length > 0) {
      let triaged = null;
      try {
        const weeklyMod = require(path.join(VAULT_DIR, '06-Resources/scripts/weekly-ai-summary.js'));
        if (weeklyMod && typeof weeklyMod.triageDailyCommitments === 'function') {
          triaged = weeklyMod.triageDailyCommitments(tasks, 3);
        }
      } catch (_) {}
      if (triaged) {
        triaged.selected.forEach((t) => out.push(`COMMITMENT: ${t}`));
        triaged.deferred.forEach((d) => out.push(`DEFERRED (-> ${d.destination}): ${d.task}`));
      } else {
        tasks.slice(0, 3).forEach((t) => out.push(`TASK: ${t}`));
      }
    }
    logs.slice(0, 5).forEach((l) => out.push(l));
    if (includeKiwiSoul && habits.length > 0) {
      out.push(`HABITS: ${habits.join(' | ')}`);
    }
  }

  // Maintenance alerts (0 lines when clean)
  const alerts = [];
  const dumpPath = path.join(VAULT_DIR, '00-Inbox', 'quick-capture-dump.md');
  if (fs.existsSync(dumpPath)) {
    const dumpContent = fs.readFileSync(dumpPath, 'utf8');
    const dumpLines = dumpContent.split(/\r?\n/);
    const archiveIdx = dumpLines.findIndex((l) => /^##\s+.*Triaged/i.test(l.trim()));
    const activeLines = archiveIdx >= 0 ? dumpLines.slice(0, archiveIdx) : dumpLines;
    const inboxCount = activeLines.filter((l) => /^\s*-\s+/.test(l)).length;
    if (inboxCount >= 5) {
      alerts.push(`⚠️ INBOX: ${inboxCount} unprocessed captures in 00-Inbox/quick-capture-dump.md`);
    }
  }

  const stamp = aucklandStamp();
  const aucklandHour = parseInt(stamp.time.split(':')[0], 10);
  if (fs.existsSync(dailyPath)) {
    const dailyContent = fs.readFileSync(dailyPath, 'utf8');
    const habitsMatch = dailyContent.match(/###\s+.*Habits[\s\S]*?(?=\n---|\n##|$)/i);
    let habitsDone = 0;
    let habitsTotal = 0;
    if (habitsMatch) {
      const habitLines = habitsMatch[0].split(/\r?\n/);
      for (const h of habitLines) {
        if (/^\s*-\s*\[x\]/i.test(h)) {
          habitsDone++;
          habitsTotal++;
        } else if (/^\s*-\s*\[ \]/i.test(h)) {
          habitsTotal++;
        }
      }
    }
    if (aucklandHour >= 18 && habitsTotal > 0 && habitsDone === 0) {
      alerts.push(`⚠️ HABITS: 0/${habitsTotal} completed today (Local time: ${stamp.time})`);
    }

    const handoffContent = fs.existsSync(handoffPath) ? fs.readFileSync(handoffPath, 'utf8') : null;
    const staleTasks = findStaleTasksInContent(dailyContent, handoffContent, stamp.date);
    for (const stale of staleTasks.slice(0, 2)) {
      alerts.push(`⚠️ STALE TASK: "${stale.text}" (${stale.days}d old)`);
    }
  }

  if (alerts.length > 0) {
    out.push('\n[MAINTENANCE ALERTS]');
    alerts.forEach((a) => out.push(`- ${a}`));
  }

  if (includeKiwiSoul && fs.existsSync(soulPath)) {
    const soul = stripFrontmatterAndCode(fs.readFileSync(soulPath, 'utf8'));
    out.push('\n[KIWI CHIEF-OF-STAFF SOUL]');
    out.push(soul);
  }

  return out.join('\n');
}

// --- Pure-JS Porter Stemmer & BM25 Hybrid Search Engine ----------------------
function porterStem(word) {
  if (typeof word !== 'string' || word.length <= 2) return word;
  let w = word.toLowerCase();

  const isConsonant = (str, i) => {
    const c = str[i];
    if ('aeiou'.includes(c)) return false;
    if (c === 'y') return i === 0 ? true : !isConsonant(str, i - 1);
    return true;
  };

  const measure = (str) => {
    let count = 0, i = 0, len = str.length;
    while (i < len && isConsonant(str, i)) i++;
    while (i < len) {
      while (i < len && !isConsonant(str, i)) i++;
      if (i < len) {
        count++;
        while (i < len && isConsonant(str, i)) i++;
      }
    }
    return count;
  };

  const hasVowel = (str) => {
    for (let i = 0; i < str.length; i++) {
      if (!isConsonant(str, i)) return true;
    }
    return false;
  };

  const endsWithDoubleConsonant = (str) => {
    if (str.length < 2) return false;
    return str[str.length - 1] === str[str.length - 2] && isConsonant(str, str.length - 1);
  };

  const endsCvc = (str) => {
    const l = str.length;
    if (l < 3) return false;
    return isConsonant(str, l - 1) &&
      !isConsonant(str, l - 2) &&
      isConsonant(str, l - 3) &&
      !'wxy'.includes(str[l - 1]);
  };

  // Step 1a
  if (w.endsWith('sses')) w = w.slice(0, -2);
  else if (w.endsWith('ies')) w = w.slice(0, -2);
  else if (!w.endsWith('ss') && w.endsWith('s')) w = w.slice(0, -1);

  // Step 1b
  let extra1b = false;
  if (w.endsWith('eed')) {
    const stemPart = w.slice(0, -3);
    if (measure(stemPart) > 0) w = stemPart + 'ee';
  } else if (w.endsWith('ed')) {
    const stemPart = w.slice(0, -2);
    if (hasVowel(stemPart)) {
      w = stemPart;
      extra1b = true;
    }
  } else if (w.endsWith('ing')) {
    const stemPart = w.slice(0, -3);
    if (hasVowel(stemPart)) {
      w = stemPart;
      extra1b = true;
    }
  }

  if (extra1b) {
    if (w.endsWith('at') || w.endsWith('bl') || w.endsWith('iz')) {
      w += 'e';
    } else if (endsWithDoubleConsonant(w) && !w.endsWith('l') && !w.endsWith('s') && !w.endsWith('z')) {
      w = w.slice(0, -1);
    } else if (measure(w) === 1 && endsCvc(w)) {
      w += 'e';
    }
  }

  // Step 1c
  if (w.endsWith('y')) {
    const stemPart = w.slice(0, -1);
    if (hasVowel(stemPart)) w = stemPart + 'i';
  }

  // Step 2
  const step2Pairs = [
    ['ational', 'ate'], ['tional', 'tion'], ['enci', 'ence'], ['anci', 'ance'],
    ['izer', 'ize'], ['abli', 'able'], ['alli', 'al'], ['entli', 'ent'],
    ['eli', 'e'], ['ousli', 'ous'], ['ization', 'ize'], ['ation', 'ate'],
    ['ator', 'ate'], ['alism', 'al'], ['iveness', 'ive'], ['fulness', 'ful'],
    ['ousness', 'ous'], ['aliti', 'al'], ['iviti', 'ive'], ['biliti', 'ble']
  ];
  for (const [suf, rep] of step2Pairs) {
    if (w.endsWith(suf)) {
      const stemPart = w.slice(0, -suf.length);
      if (measure(stemPart) > 0) w = stemPart + rep;
      break;
    }
  }

  // Step 3
  const step3Pairs = [
    ['icate', 'ic'], ['ative', ''], ['alize', 'al'], ['iciti', 'ic'],
    ['ical', 'ic'], ['ful', ''], ['ness', '']
  ];
  for (const [suf, rep] of step3Pairs) {
    if (w.endsWith(suf)) {
      const stemPart = w.slice(0, -suf.length);
      if (measure(stemPart) > 0) w = stemPart + rep;
      break;
    }
  }

  // Step 4
  const step4Suffixes = [
    'al', 'ance', 'ence', 'er', 'ic', 'able', 'ible', 'ant', 'ement',
    'ment', 'ent', 'ou', 'ism', 'ate', 'iti', 'ous', 'ive', 'ize'
  ];
  for (const suf of step4Suffixes) {
    if (w.endsWith(suf)) {
      const stemPart = w.slice(0, -suf.length);
      if (measure(stemPart) > 1) w = stemPart;
      break;
    }
  }
  if (w.endsWith('ion')) {
    const stemPart = w.slice(0, -3);
    if (measure(stemPart) > 1 && (stemPart.endsWith('s') || stemPart.endsWith('t'))) {
      w = stemPart;
    }
  }

  // Step 5a
  if (w.endsWith('e')) {
    const stemPart = w.slice(0, -1);
    const m = measure(stemPart);
    if (m > 1 || (m === 1 && !endsCvc(stemPart))) {
      w = stemPart;
    }
  }

  // Step 5b
  if (w.endsWith('ll') && measure(w.slice(0, -1)) > 1) {
    w = w.slice(0, -1);
  }

  return w;
}

const SEARCH_STOP_WORDS = new Set([
  'a', 'about', 'above', 'after', 'again', 'against', 'all', 'am', 'an', 'and',
  'any', 'are', 'aren', 'as', 'at', 'be', 'because', 'been', 'before', 'being',
  'below', 'between', 'both', 'but', 'by', 'cannot', 'could', 'did', 'do',
  'does', 'doing', 'down', 'during', 'each', 'few', 'for', 'from', 'further',
  'had', 'has', 'have', 'having', 'he', 'her', 'here', 'hers', 'herself', 'him',
  'himself', 'his', 'how', 'i', 'if', 'in', 'into', 'is', 'isn', 'it', 'its',
  'itself', 'me', 'more', 'most', 'my', 'myself', 'no', 'nor', 'not', 'of',
  'off', 'on', 'once', 'only', 'or', 'other', 'ought', 'our', 'ours', 'ourselves',
  'out', 'over', 'own', 'same', 'she', 'should', 'so', 'some', 'such', 'than',
  'that', 'the', 'their', 'theirs', 'them', 'themselves', 'then', 'there',
  'these', 'they', 'this', 'those', 'through', 'to', 'too', 'under', 'until',
  'up', 'very', 'was', 'wasn', 'we', 'were', 'weren', 'what', 'when', 'where',
  'which', 'while', 'who', 'whom', 'why', 'with', 'would', 'you', 'your', 'yours'
]);

function tokenizeTechnical(text) {
  if (!text || typeof text !== 'string') return [];
  const camelSplit = text.replace(/([a-z0-9])([A-Z])/g, '$1 $2');
  const rawWords = camelSplit.toLowerCase().split(/[^a-z0-9]+/);
  const tokens = [];
  for (const w of rawWords) {
    if (w.length >= 2 && !SEARCH_STOP_WORDS.has(w)) {
      tokens.push(w);
    }
  }
  return tokens;
}

const DEV_SYNONYMS = {
  desync: ['stale', 'unhealthy', 'corrupt', 'disconnect', 'desynchronized', 'desynchronization', 'hang'],
  stale: ['desync', 'outdated', 'unhealthy', 'corrupt'],
  docker: ['container', 'wsl', 'mount', 'daemon', 'openviking', 'vhdx'],
  container: ['docker', 'podman', 'wsl', 'image', 'instance'],
  wsl: ['docker', 'windows', 'mount', 'drvfs', 'vhdx', 'eaccessdenied'],
  mount: ['bind', 'volume', 'wsl', 'disk', 'directory', 'storage'],
  bind: ['mount', 'volume', 'bindmount'],
  auth: ['jwt', 'token', 'session', 'guard', 'oauth', 'bearer', 'header'],
  jwt: ['auth', 'token', 'bearer', 'header'],
  token: ['jwt', 'auth', 'bearer'],
  guard: ['middleware', 'auth', 'protect', 'policy', 'interceptor'],
  perm: ['permission', 'accessdenied', 'eaccessdenied', 'chmod', 'acl'],
  permission: ['perm', 'accessdenied', 'eaccessdenied', 'chmod'],
  k8s: ['kubernetes', 'cluster', 'pod', 'deployment'],
  db: ['database', 'postgres', 'postgresql', 'sqlite', 'mysql', 'migration'],
  database: ['db', 'postgres', 'postgresql', 'sqlite', 'sql'],
  sync: ['reconcile', 'mirror', 'parity', 'reconciliation']
};

const STEMMED_DEV_SYNONYMS = new Map();
for (const [key, list] of Object.entries(DEV_SYNONYMS)) {
  const stemmedKey = porterStem(key);
  const stemmedList = new Set([key, stemmedKey]);
  for (const item of list) {
    stemmedList.add(item);
    stemmedList.add(porterStem(item));
  }
  const fullArr = Array.from(stemmedList);
  STEMMED_DEV_SYNONYMS.set(key, fullArr);
  STEMMED_DEV_SYNONYMS.set(stemmedKey, fullArr);
}

function expandQueryTerms(queryTokens) {
  const queryTerms = new Map();
  for (const rawTok of queryTokens) {
    const sTok = porterStem(rawTok);
    queryTerms.set(sTok, Math.max(queryTerms.get(sTok) || 0, 1.0));
    if (rawTok !== sTok) {
      queryTerms.set(rawTok, Math.max(queryTerms.get(rawTok) || 0, 1.0));
    }
    const syns = STEMMED_DEV_SYNONYMS.get(rawTok) || STEMMED_DEV_SYNONYMS.get(sTok);
    if (syns) {
      for (const syn of syns) {
        if (!queryTerms.has(syn)) {
          queryTerms.set(syn, 0.75);
        }
      }
    }
  }
  return queryTerms;
}

let _bm25CachedVault = null;
let _bm25CachedSig = null;
let _bm25CachedIndex = null;

function extractSectionsForSearch(content) {
  if (!content || typeof content !== 'string') {
    return { summary: '', fix: '', codeText: '' };
  }
  const lines = content.split(/\r?\n/);
  const quoteLines = [];
  let inQuote = false;
  for (const line of lines) {
    if (line.trim().startsWith('>')) {
      inQuote = true;
      quoteLines.push(line.replace(/^\s*>\s*/, '').trim());
    } else if (inQuote) {
      break;
    }
  }
  const summary = quoteLines.join(' ');

  let fix = '';
  const sectionHeaderRegex = /^##\s+[^\r\n]*(?:Root Cause|Procedural Fix|Fix|Solution|Implementation|Snippet|Remediation|Usage)[^\r\n]*/im;
  const match = content.match(sectionHeaderRegex);
  if (match) {
    const startIdx = content.indexOf(match[0]) + match[0].length;
    const rest = content.slice(startIdx);
    const endMatch = rest.match(/\n##\s+|\n---\s*$/);
    const sectionBody = endMatch ? rest.slice(0, endMatch.index) : rest;
    const bodyLines = sectionBody.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    fix = bodyLines.slice(0, 8).join('\n');
  } else if (summary) {
    fix = summary;
  }

  const codeBlocks = [];
  const codeRegex = /```[\s\S]*?```/g;
  let codeMatch;
  while ((codeMatch = codeRegex.exec(content)) !== null) {
    codeBlocks.push(codeMatch[0]);
  }

  return { summary, fix, codeText: codeBlocks.join(' ') };
}

function buildVaultBM25Index(vaultRoot) {
  const targetDirs = ['03-Dev', '08-Concepts'];
  const docs = [];
  let sig = '';

  for (const relDir of targetDirs) {
    const absDir = path.join(vaultRoot, relDir);
    if (!fs.existsSync(absDir)) continue;
    try {
      const dirStat = fs.statSync(absDir);
      sig += `${relDir}:${dirStat.mtimeMs};`;
      const entries = fs.readdirSync(absDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith('.md') || entry.name.startsWith('.')) continue;
        const absFile = path.join(absDir, entry.name);
        const fStat = fs.statSync(absFile);
        sig += `${entry.name}:${fStat.mtimeMs};`;
        const content = fs.readFileSync(absFile, 'utf8');
        const title = entry.name.replace(/\.md$/, '');
        const relPath = `${relDir}/${entry.name}`;
        const { summary, fix, codeText } = extractSectionsForSearch(content);

        const termFreqs = new Map();
        const addTokens = (text, boost) => {
          const toks = tokenizeTechnical(text);
          for (const t of toks) {
            const st = porterStem(t);
            termFreqs.set(st, (termFreqs.get(st) || 0) + boost);
            if (t !== st) {
              termFreqs.set(t, (termFreqs.get(t) || 0) + (boost * 0.8));
            }
          }
        };

        addTokens(title, 3.0);
        if (fix) addTokens(fix, 2.0);
        if (codeText) addTokens(codeText, 1.5);
        addTokens(content, 1.0);

        let dl = 0;
        for (const count of termFreqs.values()) dl += count;

        docs.push({ title, relPath, summary, fix, termFreqs, dl });
      }
    } catch (_) {}
  }

  const N = docs.length;
  let totalDl = 0;
  const docFreq = new Map();
  for (const doc of docs) {
    totalDl += doc.dl;
    for (const term of doc.termFreqs.keys()) {
      docFreq.set(term, (docFreq.get(term) || 0) + 1);
    }
  }

  const avgdl = N > 0 ? totalDl / N : 1;
  const idfMap = new Map();
  for (const [term, df] of docFreq.entries()) {
    const idf = Math.log(1 + (N - df + 0.5) / (df + 0.5));
    idfMap.set(term, Math.max(idf, 0.1));
  }

  return { vaultRoot, sig, docs, avgdl, N, idfMap };
}

function getOrUpdateBM25Index(vaultRoot) {
  if (_bm25CachedVault === vaultRoot && _bm25CachedIndex) {
    let currentSig = '';
    for (const relDir of ['03-Dev', '08-Concepts']) {
      const absDir = path.join(vaultRoot, relDir);
      if (fs.existsSync(absDir)) {
        try {
          currentSig += `${relDir}:${fs.statSync(absDir).mtimeMs};`;
        } catch (_) {}
      }
    }
    if (currentSig === _bm25CachedSig) {
      return _bm25CachedIndex;
    }
  }

  const newIndex = buildVaultBM25Index(vaultRoot);
  _bm25CachedVault = vaultRoot;
  let sig = '';
  for (const relDir of ['03-Dev', '08-Concepts']) {
    const absDir = path.join(vaultRoot, relDir);
    if (fs.existsSync(absDir)) {
      try {
        sig += `${relDir}:${fs.statSync(absDir).mtimeMs};`;
      } catch (_) {}
    }
  }
  _bm25CachedSig = sig;
  _bm25CachedIndex = newIndex;
  return newIndex;
}

function searchVaultRunbooksHybrid(vaultRoot, queryString, options = {}) {
  const query = (queryString || '').trim();
  if (!query) return [];
  const rawTokens = tokenizeTechnical(query);
  if (rawTokens.length === 0) return [];

  const index = getOrUpdateBM25Index(vaultRoot);
  if (index.docs.length === 0) return [];

  const queryTerms = expandQueryTerms(rawTokens);
  const k1 = options.k1 ?? 1.2;
  const b = options.b ?? 0.75;
  const minScore = options.minScore ?? 1.2;
  const limit = options.limit ?? 2;

  const results = [];
  for (const doc of index.docs) {
    let score = 0;
    for (const [term, termWeight] of queryTerms.entries()) {
      const tf = doc.termFreqs.get(term) || 0;
      if (tf > 0) {
        const idf = index.idfMap.get(term) || 0.1;
        const termScore = idf * ((tf * (k1 + 1)) / (tf + k1 * (1 - b + b * (doc.dl / index.avgdl))));
        score += termScore * termWeight;
      }
    }
    if (score >= minScore) {
      results.push({
        title: doc.title,
        relPath: doc.relPath,
        score: Math.round(score * 100) / 100,
        summary: doc.summary,
        fix: doc.fix
      });
    }
  }

  results.sort((a, b) => b.score - a.score);
  return results.slice(0, limit);
}

function routeContextWithLaya(queryStr) {
  const query = (queryStr || getGitRepoName() || '').toLowerCase();
  const projectsDir = path.join(VAULT_DIR, '02-Projects');

  const projectCandidates = [];
  if (fs.existsSync(projectsDir)) {
    for (const entry of fs.readdirSync(projectsDir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        const subDir = path.join(projectsDir, entry.name);
        for (const f of fs.readdirSync(subDir)) {
          if (f.endsWith('.md') && !f.startsWith('_')) {
            const fullPath = path.join(subDir, f);
            const content = fs.readFileSync(fullPath, 'utf8');
            projectCandidates.push({
              name: entry.name,
              relPath: `02-Projects/${entry.name}/${f}`,
              content
            });
          }
        }
      }
    }
  }

  // Fast System-1 single-pass scoring (Laya pattern)
  let bestProject = null;
  let bestScore = 0;
  const queryTokens = query.split(/[^a-z0-9]+/).filter((w) => w.length > 2);

  for (const proj of projectCandidates) {
    const hay = `${proj.name} ${proj.content.slice(0, 1200)}`.toLowerCase();
    let score = 0;
    if (query.includes(proj.name.toLowerCase())) score += 10;
    for (const tok of queryTokens) {
      if (hay.includes(tok)) score += 2;
    }
    if (score > bestScore) {
      bestScore = score;
      bestProject = proj;
    }
  }

  // Pure-JS BM25 Hybrid Retrieval over 03-Dev & 08-Concepts
  const matchedRunbooks = searchVaultRunbooksHybrid(VAULT_DIR, query, { limit: 2, minScore: 1.2 });

  const out = [generateBrief(false)];
  out.push(`\n=== LAYA CONTEXT ROUTER (query: "${query || 'auto'}") ===`);

  if (bestProject && bestScore > 0) {
    const statusMatch = bestProject.content.match(/^status:\s*([^\r\n]+)/m);
    const status = statusMatch ? statusMatch[1].trim() : 'unknown';
    const openTasks = bestProject.content
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => /^- \[[ \/]\] \S+/.test(l))
      .slice(0, 8);
    out.push(`Matched Project Hub: ${bestProject.relPath} (status: ${status}, score: ${bestScore})`);
    if (openTasks.length > 0) {
      out.push('Active Hub Tasks:');
      openTasks.forEach((t) => out.push(`  ${t}`));
    }
  } else {
    out.push('Matched Project Hub: none (external repo or general system session)');
  }

  if (matchedRunbooks.length > 0) {
    out.push('Matched Runbooks / 03-Dev Snippets:');
    for (const r of matchedRunbooks) {
      out.push(`  - ${r.relPath} (score: ${r.score})`);
      if (r.summary) {
        out.push(`    Summary: ${r.summary}`);
      }
      if (r.fix && r.fix !== r.summary) {
        const indentFix = r.fix.split('\n').map((l) => `    ${l}`).join('\n');
        out.push(`    Procedural Fix:\n${indentFix}`);
      }
    }
  } else {
    out.push('Matched Runbooks: none');
  }

  return out.join('\n');
}

function crystallizeSkill(titleRaw, bodyRaw, langOpt = 'bash') {
  const { dateStr } = getTodayInfo();
  const safeTitle = titleRaw.replace(/[\/\\:*?"<>|]/g, '-').trim();
  const devDir = path.join(VAULT_DIR, '03-Dev');
  if (!fs.existsSync(devDir)) {
    fs.mkdirSync(devDir, { recursive: true });
  }
  const filePath = path.join(devDir, `${safeTitle}.md`);
  const topicTag = safeTitle.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2)[0] || 'debugging';

  const noteContent = `---
created: ${dateStr}
updated: ${dateStr}
type: snippet
area: dev
status: active
language: ${langOpt}
source: heyloey-learn
tags:
  - type/snippet
  - area/dev
  - status/active
  - topic/${topicTag}
---

# 💻 ${safeTitle}

> **${bodyRaw}**

---

## 🔍 Root Cause & Procedural Fix
- ${bodyRaw}
- Captured from repository context: \`${getGitContext().trim() || 'global'}\` on ${dateStr}.

---

## 🔗 Related Resources & Notes
- [[03-Dev/_Dev MOC|_Dev MOC]]
`;

  atomicWriteFileSync(filePath, noteContent);
  console.log(`[heyloey] Crystallized procedural runbook: 03-Dev/${safeTitle}.md`);
  logToDailyNote(`[learn] Crystallized procedural runbook into 03-Dev/${safeTitle}.md`);
}

function runDreamLoop() {
  const { dateStr, monthDir } = getTodayInfo(0);
  const yesterday = getTodayInfo(-1);

  console.log(`[heyloey] 🌙 Running Nightly Dream Loop & Anti-Rot Maintenance (${dateStr})...`);

  // 1. Prune handoff.md overflow to 07-Reviews/handoff-archive-YYYY-MM.md
  const handoffPath = path.join(VAULT_DIR, 'handoff.md');
  let prunedCount = 0;
  if (fs.existsSync(handoffPath)) {
    const rawHandoff = fs.readFileSync(handoffPath, 'utf8');
    const pruned = pruneHandoffContent(rawHandoff, MAX_HANDOFF_UPDATES);
    prunedCount = pruned.prunedCount;
    if (prunedCount > 0) {
      atomicWriteFileSync(handoffPath, pruned.content);
    }
  }
  console.log(`  1. Handoff hygiene: ${prunedCount > 0 ? `archived ${prunedCount} older update(s) to 07-Reviews/handoff-archive-${monthDir}.md` : `clean (<= ${MAX_HANDOFF_UPDATES} updates)`}`);

  // 2. Carry over up to 3 unfinished tasks from yesterday INTO TODAY'S EXISTING note.
  //    Today's note is never created here: an absent note is refused, not invented.
  const todayPath = dailyNotePath(dateStr, monthDir);
  const yesterdayPath = path.join(VAULT_DIR, '01-Daily', yesterday.monthDir, `${yesterday.dateStr}.md`);
  let carriedCount = 0;

  if (fs.existsSync(yesterdayPath)) {
    const yContent = fs.readFileSync(yesterdayPath, 'utf8');
    let inTasks = false;
    const unfinished = [];
    for (const line of yContent.split(/\r?\n/)) {
      if (line.startsWith('### ✅ Tasks')) {
        inTasks = true;
        continue;
      }
      if (inTasks && (line.startsWith('#') || line.startsWith('---'))) {
        inTasks = false;
      }
      if (inTasks && /^- \[ \] \S+/.test(line.trim())) {
        unfinished.push(line.trim());
      }
    }

    if (unfinished.length > 0 && fs.existsSync(todayPath)) {
      let tContent = fs.readFileSync(todayPath, 'utf8');
      const toCarry = unfinished.slice(0, 3).filter((item) => !tContent.includes(item));
      if (toCarry.length > 0 && tContent.includes('### ✅ Tasks')) {
        const carryBlock = toCarry.join('\n');
        // Callback form: carryBlock carries user task text.
        tContent = tContent.replace(/### ✅ Tasks\r?\n(- \[ \][ \t]*\r?\n)?/, () => `### ✅ Tasks\n${carryBlock}\n`);
        atomicWriteFileSync(todayPath, tContent);
        carriedCount = toCarry.length;
      }
    }
  }
  console.log(
    fs.existsSync(todayPath)
      ? `  2. Daily Note (${dateStr}): ready (${carriedCount} unfinished task(s) carried over from ${yesterday.dateStr})`
      : `  2. Daily Note (${dateStr}): absent - NOT created; ${DAILY_NOTE_HINT}. No tasks carried over.`
  );

  // 3. Check memory.md budget
  const memPath = path.join(VAULT_DIR, 'memory.md');
  if (fs.existsSync(memPath)) {
    const rawMem = fs.readFileSync(memPath, 'utf8');
    const lines = rawMem.split(/\r?\n/).length;
    const bytes = Buffer.byteLength(rawMem, 'utf8');
    const status = lines < 150 && bytes < 6144 ? '✅ HEALTHY' : '⚠️ OVER 75% THRESHOLD';
    console.log(`  3. Core Memory Budget: ${lines}/200 lines, ${bytes}/8192 bytes (${status})`);
  }
}

const args = process.argv.slice(2);
const command = args[0] ? args[0].toLowerCase() : 'help';
const rawMessage = args.slice(1).join(' ').trim();

if (!fs.existsSync(VAULT_DIR)) {
  console.error(`[heyloey] Error: Vault directory does not exist: ${VAULT_DIR}`);
  process.exit(1);
}

const prefix = getGitContext();
const formattedMessage = rawMessage ? `${prefix}${cleanMessage(rawMessage)}` : '';

// Agent milestones and owner entries take free text only. A flag used to be swallowed as part of
// the text, which silently wrote `--personal` into the agent table; refuse instead of guessing.
if (['done', 'milestone', 'personal'].includes(command)) {
  const flags = args.slice(1).filter((arg) => arg.startsWith('--'));
  if (flags.length) {
    console.error(
      `[heyloey] Unsupported option(s) for ${command}: ${flags.join(', ')}.\n` +
        '[heyloey] Agent milestones take free text only; use `heyloey personal "<entry>"` for an owner entry. Nothing written.'
    );
    process.exit(1);
  }
}

// Commands that WRITE vault records. Readers (brief/context/status/help/install-hook)
// take no lock: contention should never delay a read, and install-hook writes into a
// repository's own .git/hooks, not into vault records.
const WRITER_COMMANDS = new Set(['done', 'milestone', 'personal', 'log', 'sync', 'handoff', 'save', 'learn', 'snippet', 'dream', 'prune', 'migrate-log']);

async function dispatch() {
  if (WRITER_COMMANDS.has(command)) {
    // Refuse BEFORE the lock and before any read of a record. A configuration that
    // names the removed tier is an error, never a hint to select something else.
    const obsolete = obsoleteLockConfig();
    if (obsolete.length) {
      console.error(
        `[heyloey] LOCK unavailable: the lock configuration names the removed metadata-file tier, which this version will not use or reinterpret: ${obsolete.join('; ')}.\n` +
          '[heyloey] LOCK hint: unset the retired knob(s). The required protocol is the kernel lock (LOEY_LOCK_IMPL=auto, the default). Nothing written.'
      );
      process.exit(OUTCOME_EXIT['lock-unavailable']);
    }
    // Legacy metadata locks are inspected here AND again inside the flocked child, so
    // state that appears during the wait is still refused rather than written around.
    refuseIfLegacyLockPresent();
    if (LOCK_ALREADY_HELD) {
      // This process IS the flocked CHILD: the kernel holds the lock on its behalf.
      // `LOEY_LOCK_HOLD_MS` (inert by default) widens the critical section so the
      // contention and orphan regressions are deterministic rather than racy.
      if (LOCK_HOLD_MS > 0) await delayAsync(LOCK_HOLD_MS);
      // Ownership is re-checked AFTER any wait, and again before every vault write
      // inside atomicWriteFileSync: an orphaned child must never write without the lock.
      assertKernelLockHeld();
      LOCK_IMPL_IN_FORCE = 'flock';
    } else {
      if (!flockBinPath()) {
        console.error(
          '[heyloey] LOCK unavailable: every vault-writing command is serialized with the kernel-managed `flock`, and no `flock` binary was found on this host.\n' +
            '[heyloey] LOCK hint: `flock` ships with util-linux (Debian/Ubuntu: apt-get install util-linux). On Windows, run through WSL - the supported path for this vault - and install util-linux inside that distribution.\n' +
            '[heyloey] LOCK hint: there is NO fallback protocol and none is selected automatically. Nothing written.'
        );
        process.exit(OUTCOME_EXIT['lock-unavailable']);
      }
      // Re-executes the whole command as a child of `flock`, then exits with its code.
      await runUnderKernelLock();
      return;
    }
  } else {
    // Readers (brief/context/status/lock-state/help/install-hook) take no lock:
    // contention must never delay a read. Obsolete configuration is still REPORTED,
    // so a stale environment cannot pass unnoticed, but it blocks nothing here.
    const obsolete = obsoleteLockConfig();
    if (obsolete.length) {
      console.error(
        `[heyloey] LOCK warning: ${obsolete.join('; ')}. This command is read-only, so no lock protocol is selected or needed; unset the retired knob(s) before running a writer.`
      );
    }
  }
  switch (command) {
  case 'log':
  case 'sync': {
    if (!formattedMessage || rawMessage.length < 5) {
      console.error('Error: Message must be at least 5 characters.');
      process.exit(1);
    }
    const synthetic = detectSynthetic();
    // The whole read-modify-write already runs under the process-wide vault lock
    // taken by dispatch() before this case was reached.
    const daily = logToDailyNote(formattedMessage, synthetic);
    const outcome = summarizeOutcome([daily], synthetic);
    reportOutcome('log', [['daily', daily]], outcome, synthetic);
    process.exit(OUTCOME_EXIT[outcome]);
  }

  case 'handoff':
  case 'save': {
    if (!formattedMessage || rawMessage.length < 5) {
      console.error('Error: Message must be at least 5 characters.');
      process.exit(1);
    }
    const synthetic = detectSynthetic();
    const handoff = updateHandoff(formattedMessage, synthetic);
    const outcome = summarizeOutcome([handoff], synthetic);
    reportOutcome('handoff', [['handoff', handoff]], outcome, synthetic);
    process.exit(OUTCOME_EXIT[outcome]);
  }

  case 'done':
  case 'milestone': {
    if (!formattedMessage || rawMessage.length < 5) {
      console.error('Error: Message must be at least 5 characters.');
      process.exit(1);
    }
    const synthetic = detectSynthetic();
    const { dateStr, monthDir } = getTodayInfo();
    const handoffPath = path.join(VAULT_DIR, 'handoff.md');
    const dailyPath = dailyNotePath(dateStr, monthDir);
    const { summary } = splitScopeAndSummary(formattedMessage);
    const needle = summary.length > 0 ? summary : formattedMessage;

    // The process-wide lock (already held) covers the pre-check, BOTH writes and the
    // final verification, so a concurrent writer cannot replace either record from a
    // stale read in between.
    const res = (() => {
      // A milestone needs BOTH records. If EITHER is absent, refuse the whole command
      // up front and write nothing: never half-log the other record and call it done.
      const hasHandoff = fs.existsSync(handoffPath);
      const hasDaily = fs.existsSync(dailyPath);
      if (!synthetic.synthetic && (!hasHandoff || !hasDaily)) {
        const daily = hasDaily
          ? { status: 'not-attempted', path: vaultRel(dailyPath), detail: 'refused: a required record is absent' }
          : { status: 'missing', path: vaultRel(dailyPath), detail: 'daily note absent' };
        const handoff = hasHandoff
          ? { status: 'not-attempted', path: vaultRel(handoffPath), detail: 'refused: a required record is absent' }
          : { status: 'missing', path: vaultRel(handoffPath), detail: 'handoff.md absent' };
        if (!hasDaily) {
          console.error(`[heyloey] REFUSED daily note: ${daily.path} is absent - ${DAILY_NOTE_HINT}; nothing written.`);
        }
        if (!hasHandoff) {
          console.error(`[heyloey] REFUSED handoff: ${handoff.path} is absent (create it with \`npm run init:vault\`); nothing written.`);
        }
        console.error('[heyloey] A milestone needs BOTH records, so neither was written.');
        reportOutcome('done', [['daily', daily], ['handoff', handoff]], 'refused', synthetic);
        return { refused: true };
      }
      const daily = logToDailyNote(formattedMessage, synthetic);
      const handoff = updateHandoff(formattedMessage, synthetic);
      // Success is reported ONLY after re-reading BOTH required records from disk
      // (still under the lock) and confirming the intended milestone is inside the
      // expected section of each.
      return {
        daily,
        handoff,
        finalDaily: verifySectionContains(dailyPath, ['## 📝 Daily Log', '## 🛠️ Work Log'], needle),
        finalHandoff: verifySectionContains(handoffPath, ['### Latest Updates'], needle),
      };
    })();
    if (res.refused) process.exit(OUTCOME_EXIT.refused);
    const { daily, handoff, finalDaily, finalHandoff } = res;
    let outcome;
    if (synthetic.synthetic) {
      outcome = 'skipped';
    } else if (finalDaily.ok && finalHandoff.ok) {
      // Retry reconciliation: a retry after a partial write finds the already-present
      // half as `already-recorded` and completes the other half, so the pair is still
      // reported as logged (both records now hold the milestone).
      outcome =
        daily.status === 'already-recorded' && handoff.status === 'already-recorded' ? 'already-recorded' : 'logged';
    } else if (finalDaily.ok || finalHandoff.ok) {
      outcome = 'partial';
    } else {
      outcome = 'failed';
    }
    if (!synthetic.synthetic && !(finalDaily.ok && finalHandoff.ok)) {
      console.error(
        `[heyloey] FINAL VERIFICATION: daily=${finalDaily.ok ? 'verified' : `NOT verified (${finalDaily.reason})`}` +
          `; handoff=${finalHandoff.ok ? 'verified' : `NOT verified (${finalHandoff.reason})`}`
      );
    }
    reportOutcome(
      'done',
      [['daily', daily], ['handoff', handoff]],
      outcome,
      synthetic,
      ` verified=${finalDaily.ok ? 'daily' : ''}${finalHandoff.ok ? '+handoff' : ''}`
    );
    process.exit(OUTCOME_EXIT[outcome]);
  }

  case 'personal': {
    if (!rawMessage || cleanMessage(rawMessage).length < 5) {
      console.error('Error: Message must be at least 5 characters.');
      process.exit(1);
    }
    const synthetic = detectSynthetic();
    const daily = logToPersonal(rawMessage, synthetic);
    const outcome =
      daily.status === 'written' ? 'logged' :
      daily.status === 'already-recorded' ? 'already-recorded' :
      daily.status === 'missing' ? 'refused' : daily.status;
    reportOutcome(
      'personal',
      [['daily', daily], ['handoff', { status: 'not-attempted', path: 'handoff.md', detail: 'personal entries never enter handoff' }]],
      outcome,
      synthetic,
      daily.status === 'written' || daily.status === 'already-recorded' ? ' verified=daily' : ''
    );
    process.exit(OUTCOME_EXIT[outcome] ?? 1);
  }

  case 'migrate-log':
  case 'migrate': {
    const parsed = parseMigrateArgs(args.slice(1));
    if (parsed.errors.length) {
      for (const message of parsed.errors) console.error(`[heyloey] ${message}`);
      console.error('[heyloey] Nothing written.');
      process.exit(1);
    }
    if (parsed.date && !/^\d{4}-\d{2}-\d{2}$/.test(parsed.date)) {
      console.error(`[heyloey] --date must be YYYY-MM-DD, got "${parsed.date}". Nothing written.`);
      process.exit(1);
    }

    const synthetic = detectSynthetic();
    const dateStr = parsed.date || getTodayInfo().dateStr;
    const rel = path.join('01-Daily', dateStr.slice(0, 7), `${dateStr}.md`);
    const notePath = path.join(VAULT_DIR, rel);

    if (synthetic.synthetic) {
      console.log(`[heyloey] SKIPPED migrate-log - explicit synthetic opt-out (${synthetic.reason}); nothing written.`);
      process.exit(OUTCOME_EXIT.skipped);
    }
    if (!fs.existsSync(notePath)) {
      console.error(`[heyloey] REFUSED migrate-log: ${rel} is absent - ${DAILY_NOTE_HINT}; nothing written.`);
      reportOutcome('migrate-log', [['daily', { status: 'missing', path: rel, detail: 'daily note absent' }]], 'refused', synthetic);
      process.exit(OUTCOME_EXIT.refused);
    }

    const original = fs.readFileSync(notePath, 'utf8');
    const migrated = migrateAgentMilestones(original, {
      selectStamps: parsed.select,
      selectSummaries: parsed.selectSummaries
    });

    if (!migrated.ok) {
      console.error(`[heyloey] REFUSED migrate-log: ${rel} has no ${DAILY_LOG_HEADING} section, so there is nothing to separate. Nothing written.`);
      reportOutcome('migrate-log', [['daily', { status: 'missing', path: rel, detail: 'daily log section absent' }]], 'refused', synthetic);
      process.exit(OUTCOME_EXIT.refused);
    }
    if (migrated.selectionErrors.length) {
      for (const message of migrated.selectionErrors) console.error(`[heyloey] ${message}`);
      console.error('[heyloey] Nothing written. Name exactly one personal entry per --select/--select-summary; an ambiguous or unmatched selection is refused rather than guessed.');
      reportOutcome('migrate-log', [['daily', { status: 'not-attempted', path: rel, detail: 'selection invalid' }]], 'refused', synthetic, ` migrated=0 kept=${migrated.kept.length} adopted=0 note=${rel}`);
      process.exit(OUTCOME_EXIT.refused);
    }

    if (parsed.dryRun) {
      console.log(`[heyloey] DRY RUN - nothing written. Vault: ${VAULT_DIR}`);
      console.log(`[heyloey]   ${rel} [${LOG_AREA_HEADINGS.personal} -> ${LOG_AREA_HEADINGS.agent}]`);
      for (const summary of migrated.moved) console.log(`[heyloey]     -> ${summary}`);
      if (migrated.adopted > 0) console.log(`[heyloey]     => ${migrated.adopted} legacy callout(s) adopted by the agent area`);
      for (const summary of migrated.kept) console.log(`[heyloey]     . left in place: ${summary}`);
      process.exit(0);
    }

    const extra = ` migrated=${migrated.moved.length} kept=${migrated.kept.length} adopted=${migrated.adopted} note=${rel} verified=daily`;
    if (migrated.content === original) {
      console.log(`[heyloey] ALREADY-RECORDED migrate-log: ${rel} is already separated (${migrated.moved.length} moved, ${migrated.kept.length} left in place); nothing changed.`);
      reportOutcome('migrate-log', [['daily', { status: 'already-recorded', path: rel, detail: 'note already separated' }]], 'already-recorded', synthetic, extra);
      process.exit(OUTCOME_EXIT['already-recorded']);
    }

    try {
      atomicWriteFileSync(notePath, migrated.content);
    } catch (e) {
      console.error(`[heyloey] FAILED migrate-log: ${rel} - ${e.message}`);
      reportOutcome('migrate-log', [['daily', { status: 'failed', path: rel, detail: e.message }]], 'failed', synthetic, extra);
      process.exit(OUTCOME_EXIT.failed);
    }
    if (fs.readFileSync(notePath, 'utf8') !== migrated.content) {
      console.error(`[heyloey] FAILED migrate-log: ${rel} - post-write verification failed; the note is not as written.`);
      reportOutcome('migrate-log', [['daily', { status: 'failed', path: rel, detail: 'post-write verification failed' }]], 'failed', synthetic, extra);
      process.exit(OUTCOME_EXIT.failed);
    }
    console.log(`[heyloey] SEPARATED ${rel}: ${migrated.moved.length} moved, ${migrated.adopted} callout(s) adopted, ${migrated.kept.length} left in place.`);
    reportOutcome('migrate-log', [['daily', { status: 'written', path: rel, detail: 'note separated' }]], 'logged', synthetic, extra);
    process.exit(0);
  }

  case 'brief':
    const includeKiwi = args.includes('--kiwi') || args.includes('--soul');
    console.log(generateBrief(includeKiwi));
    break;

  case 'context':
  case 'route':
    const queryArg = args.slice(1).filter((a) => !a.startsWith('--')).join(' ');
    console.log(routeContextWithLaya(queryArg));
    break;

  case 'learn':
  case 'snippet': {
    const nonFlagArgs = args.slice(1).filter((a) => !a.startsWith('--'));
    const langFlag = args.find((a) => a.startsWith('--lang='));
    const lang = langFlag ? langFlag.split('=')[1] : 'bash';
    const title = nonFlagArgs[0];
    const fix = nonFlagArgs.slice(1).join(' ').trim();
    if (!title || !fix) {
      console.error('Usage: heyloey learn "<Title>" "<Root cause & reusable fix>" [--lang=typescript|bash|python]');
      process.exit(1);
    }
    crystallizeSkill(title, fix, lang);
    break;
  }

  case 'dream':
  case 'prune':
    runDreamLoop();
    break;

  case 'status': {
    const { dateStr, monthDir } = getTodayInfo();
    const dailyPath = path.join(VAULT_DIR, '01-Daily', monthDir, `${dateStr}.md`);
    const handoffPath = path.join(VAULT_DIR, 'handoff.md');
    const soulPath = path.join(VAULT_DIR, '00-Private', 'SOUL.md');
    console.log(`[heyloey] Vault: ${VAULT_DIR} (source: ${VAULT_TARGET.source})`);
    console.log(`[heyloey] Git context: ${prefix || '(none)'}`);
    console.log(`[heyloey] Today's note (${dateStr}): ${fs.existsSync(dailyPath) ? 'EXISTS' : 'NOT CREATED YET'}`);
    console.log(`[heyloey] Handoff file: ${fs.existsSync(handoffPath) ? 'EXISTS' : 'NOT FOUND'}`);
    console.log(`[heyloey] Kiwi SOUL.md: ${fs.existsSync(soulPath) ? 'EXISTS' : 'NOT FOUND'}`);
    break;
  }

  case 'lock-state': {
    // Read-only migration inspection. Takes no lock and writes nothing, so it can be
    // run while a legacy lock is present - which is exactly when it is needed.
    const obsolete = obsoleteLockConfig();
    const legacy = legacyLockState();
    const kernel = kernelLockPath();
    const bin = flockBinPath();
    console.log(`[heyloey] Vault: ${VAULT_DIR} (source: ${VAULT_TARGET.source})`);
    console.log('[heyloey] LOCK protocol: kernel-managed flock (required for every writer; no fallback exists)');
    console.log(`[heyloey] LOCK flock binary: ${bin || 'NOT FOUND - writers refuse, exit 8'}`);
    console.log(
      `[heyloey] LOCK kernel lock file: ${kernel}` +
        (fs.existsSync(kernel) ? ' [exists: flock locks the inode; its contents carry no ownership]' : '')
    );
    if (legacy.present) {
      console.log(`[heyloey] LOCK legacy file-tier lock: PRESENT at ${legacy.path}`);
      console.log(
        `[heyloey] LOCK legacy holder: ${
          legacy.meta
            ? `pid=${legacy.meta.pid} token=${legacy.meta.token || '?'} started=${legacy.meta.started || '?'} command=${legacy.meta.command || '?'}`
            : 'metadata unreadable'
        }`
      );
      console.log(`[heyloey] LOCK legacy liveness: ${legacyHolderLiveness(legacy.meta)}`);
      console.log('[heyloey] LOCK verdict: NOT migration-ready. Writers refuse (exit 9) and nothing is removed; verify quiescence by hand, then remove the legacy file yourself.');
    } else {
      console.log(`[heyloey] LOCK legacy file-tier lock: absent (${legacy.path})`);
    }
    console.log(
      obsolete.length
        ? `[heyloey] LOCK configuration: OBSOLETE - ${obsolete.join('; ')} (writers refuse, exit 8)`
        : `[heyloey] LOCK configuration: ok (LOEY_LOCK_IMPL=${LOCK_IMPL_REQUESTED}; no retired knob set)`
    );
    console.log('[heyloey] LOCK note: this command takes no lock and writes nothing.');
    if (legacy.present) process.exit(OUTCOME_EXIT['legacy-lock-present']);
    if (obsolete.length || !bin) process.exit(OUTCOME_EXIT['lock-unavailable']);
    break;
  }

  case 'install-hook':
  case 'hook':
    try {
      const repoRoot = execSync('git rev-parse --show-toplevel 2>/dev/null', { encoding: 'utf8' }).trim();
      if (!repoRoot) {
        console.error('Error: Not inside a git repository.');
        process.exit(1);
      }
      const hooksDir = path.join(repoRoot, '.git', 'hooks');
      if (!fs.existsSync(hooksDir)) {
        fs.mkdirSync(hooksDir, { recursive: true });
      }
      const hookPath = path.join(hooksDir, 'post-commit');
      const hookScript = `#!/usr/bin/env bash
# Git post-commit hook for automated loey_space daily logging
if command -v heyloey >/dev/null 2>&1; then
  COMMIT_MSG=$(git log -1 --pretty=%s 2>/dev/null)
  if [ -n "$COMMIT_MSG" ]; then
    heyloey log "$COMMIT_MSG" >/dev/null 2>&1 &
  fi
fi
`;
      fs.writeFileSync(hookPath, hookScript, { encoding: 'utf8', mode: 0o755 });
      console.log(`[heyloey] Installed post-commit hook into ${hookPath}`);
    } catch (e) {
      console.error('Failed to install hook:', e.message);
      process.exit(1);
    }
    break;

  default:
    console.log(`Usage: heyloey <command> [args]
Commands:
  brief [--kiwi]             Condensed ~400-token snapshot of memory + handoff + today's tasks (add --kiwi for SOUL.md)
  lock-state                 Read-only report: lock protocol, \`flock\` presence, configuration, and any
                             legacy file-tier lock state (exit 0 ready / 8 unusable / 9 legacy state)
  context [query]            Laya System-1 context router: outputs brief + matched 02-Projects hub & 03-Dev runbooks
  learn "<title>" "<fix>"    Crystallize a reusable debugging fix/pattern into 03-Dev/<title>.md (--lang=bash|ts|py)
  dream                      Run Nightly Dream Loop (auto-prune handoff.md >10 items to 07-Reviews/, carry over tasks, check rot)
  done "<msg>"               Log to today's daily note AND update handoff.md (with auto-pruning & deduplication)
  personal "<entry>"         Owner's own entry: today's \`### 🧍 Personal Log\` only; handoff.md is never touched
  log "<msg>"                Append entry to today's daily note
  handoff "<msg>"            Update handoff.md (with auto-pruning)
  status                     Check status of daily note, handoff, and Kiwi SOUL.md
  install-hook               Install auto-logging post-commit hook into current git repo
  migrate-log [options]      Separate one daily note: create its labelled areas and fold agent
                             bullets/callouts into the one agent table. A personal entry moves
                             only when named with --select or --select-summary.

Targeting:
  LOEY_SPACE_DIR=<dir>       Target vault for this CLI. Overrides LOEY_VAULT_ROOT.
  LOEY_VAULT_ROOT=<dir>      Fallback target; the same variable the MCP launcher uses.
  (neither set)              Defaults to ~/loey_space (${DEFAULT_VAULT_DIR}).
  LOEY_SPACE_SYNTHETIC=1     Explicit synthetic-test opt-out: writes nothing.
                             A '.loey-synthetic' sentinel in the repo root or cwd
                             has the same effect.

  --date <day>               With migrate-log: the daily note to separate (YYYY-MM-DD). Default: today.
  --select <time>            With migrate-log: move exactly one personal entry with this time, e.g. "09:21 AM".
  --select-summary <text>    With migrate-log: the same, by a unique substring of the summary.
  --dry-run                  With migrate-log: report what would move and write nothing.

Outcomes (also emitted as one machine-readable line:
  [heyloey] RESULT <cmd> <outcome> <record>=<status> ... target=<dir> source=<src>)
  logged             exit 0   all required records written
  already-recorded   exit 0   all required records already contain the entry
  skipped            exit 3   explicit synthetic opt-out; nothing written
  refused            exit 4   a required record is absent; nothing written
  partial            exit 5   at least one record written and at least one failed
  failed             exit 6   a write failed; no record was changed
  lock-contended      exit 7   another process held the kernel lock; nothing written
  lock-unavailable    exit 8   \`flock\` is missing/unusable, or the lock configuration
                              names the removed file tier; nothing written
  legacy-lock-state   exit 9   a metadata lock from the removed file tier exists;
                              nothing written, nothing removed, operator review needed
  (usage/config)      exit 1   bad message or unusable target

Vault write serialization:
  ONE protocol, and it is REQUIRED: every command that writes vault records runs the
  whole read-modify-write as a child of kernel \`flock\`, keyed by the RESOLVED vault
  path, so concurrent callers (including Windows shells that delegate through
  \`wsl.exe -e\`) serialize instead of each replacing a record from a stale read.
  Nested helpers (learn -> daily log, dream -> handoff prune) share that one lock.

    flock  The kernel owns the lock: it arbitrates ownership, and it releases on ANY
           exit of the holder, including SIGKILL, so there is NO stale lock state and
           NO takeover heuristic anywhere in this program. The lock file carries no
           ownership data; \`flock\` locks its inode and leftover files confer nothing.

  DEPENDENCY: \`flock\` is part of util-linux. It is present on Linux and under WSL,
  which is the supported Windows path for this vault; the Windows shims delegate to
  \`wsl.exe -e\`. Where it is missing the CLI REFUSES (exit 8) before touching a
  record - it does not fall back, and there is no second protocol to fall back to.

  REMOVED TIER: the portable metadata-file fallback (LOEY_LOCK_IMPL=file) is gone.
  Requesting it, or setting the retired knobs LOEY_LOCK_RECOVERY, LOEY_LOCK_STALE_MS
  or LOEY_LOCK_RECLAIM_DELAY_MS, is refused (exit 8) rather than silently resolved to
  another protocol. A metadata lock file left by that tier is never adopted, never
  removed and never taken over: while it exists every writer refuses (exit 9) pending
  an operator-verified quiescent migration (see MIGRATION-legacy-lock-and-flock.md).

  LOEY_LOCK_DIR          lock directory (default /tmp/heyloey-locks)
  LOEY_LOCK_TIMEOUT_MS   wait before giving up on a held lock (default 15000)
  LOEY_LOCK_IMPL         auto|flock (default auto). Any other value is refused.
  LOEY_LOCK_HOLD_MS      test knob, default 0: hold the lock this long before working
  lock-state             read-only report: protocol, flock presence, legacy lock state
  SIGINT or SIGTERM cancels a waiting contender immediately; there is no lock state
  left behind to clean up. A writer killed with SIGKILL is handled by the kernel.

An 'Auto-logged' claim is licensed ONLY when the RESULT says logged
(or already-recorded, which must be reported as already recorded).
`);
      break;
    }
}

runAsync(dispatch);
