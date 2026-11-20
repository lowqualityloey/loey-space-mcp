# 🧠 loey-space-mcp

[![CI](https://github.com/lowqualityloey/loey-space-mcp/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/lowqualityloey/loey-space-mcp/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/github/license/lowqualityloey/loey-space-mcp)](LICENSE)

Hardened Model Context Protocol (MCP) server providing external coding agents with safe, read-only access to `loey_space` notes and a single kernel-locked milestone mutation path.

---

## 🛡️ Security Model & Architecture

- **Field Engineer vs. Chief-of-Staff Boundary**: External coding agents cannot perform generic markdown writes or scaffold daily notes. The vault curator agent owns general curation.
- **Strict Read-Only Enforcement**: Ordinary note tools (`read_text_file`, `list_directory`, `get_file_info`, `list_allowed_directories`) deny private directories (`00-Private/`, `05-Personal/`, `.secrets/`, `.git/`, `.env`) and reject directory traversal (`../`) or symlink escapes.
- **Dependency-Free Hybrid Context Retrieval**: `heyloey_context` runs a single-pass keyword scorer plus a pure-JS BM25 ranker (Porter English stemmer and technical synonym expansion) over `03-Dev/` and `08-Concepts/`. There is no external classifier or Laya call: the router is in-memory JavaScript with no native addons and no runtime dependencies.
- **Single Locked Mutation Path**: `heyloey_done` and `heyloey_learn` are the sole mutation tools. They delegate to the companion canonical CLI (`heyloey`) under util-linux kernel locks (`flock`).
- **One disclosed code-execution point**: `heyloey_brief` may `require()` the vault's own `06-Resources/scripts/weekly-ai-summary.js` when it exists. That file must stay owner-controlled; nothing in this server can write to it, but a synced or shared vault is a code surface.
- **Lossless Paging**: `read_text_file` provides windowed line paging (`head`, `offset`) and character continuation (`char_offset`), guaranteeing 100% exact source reconstruction across long-line cutoffs and blank-line boundaries.
- **Process Group Isolation**: Spawns CLI tasks detached and discovers all descendant process groups via `/proc`. If a process hangs, saturates pipe buffers (>128 KB), or times out, the entire process tree (including detached `flock` and grandchild writers) is cleanly reaped with `SIGKILL`.

---

## 🐧 Platform & Runtime Support

- **Operating System**: **Linux** or **WSL2** (Windows Subsystem for Linux).
  > **Note**: Runtime process reaping requires the Linux `/proc` virtual filesystem, and vault concurrency requires util-linux `flock`. It is not supported on bare Windows or macOS without containerization.
- **Runtime**: Node.js **>= 20.0.0** (tested on Node 20, 22, and 24).

---

## 🔗 Canonical CLI Dependency Contract

`loey-space-mcp` is an interface boundary and relies on a compatible canonical `heyloey` CLI implementation (such as `canonical/heyloey.cjs` or `$HOME/.local/bin/heyloey`):
- **Exit 0**: `RESULT done logged` — milestone recorded in today's daily note and `handoff.md`; an idempotent retry reports `already-recorded` and also exits 0.
- **Exit 3**: `RESULT done skipped` — synthetic test run (`LOEY_SPACE_SYNTHETIC=1`), nothing written.
- **Exit 4**: `RESULT done refused` — required daily note or handoff record is missing.
- **Exit 5**: Partial write — one required record was written and the other was not; the `RESULT` line names both.
- **Exit 6**: Write failed — no record was changed.
- **Exit 7**: Lock contention timed out.
- **Exit 8**: Lock unavailable (e.g. missing `flock`, or a retired lock knob is set).
- **Exit 9**: A legacy file-tier lock is present; nothing written, nothing removed, operator review needed.

**Command surface.** The canonical writer implements `brief`, `context`, `done`, `personal`, `learn`, `dream`, `log`, `handoff`, `status`, `lock-state`, `install-hook` and `migrate-log`. `migrate-log` normalises one daily note into its three labelled areas, folds bullets and a legacy callout into the single agent table, and moves a personal entry only when it is named with `--select` or `--select-summary`; it also accepts `--date` and `--dry-run`. Every command accepts `--root <dir>`, which wins over the environment variables and resolves relative paths against the working directory. Writing commands accept a global `--dry-run` (prints the lines that would be written, takes no lock, changes nothing) and `--show-paths` (absolute paths in that preview; vault-relative by default). `done` also accepts `--date <YYYY-MM-DD>` and `--time <HH:MM>` to name the moment a milestone actually happened, so a write replayed after midnight is filed in its own day's note instead of today's; the flags are refused on every other command rather than being swallowed as message text, `--date` must be a real calendar day, and the handoff's `updated:` field keeps naming when the file was touched. `done --personal` and `personal` are the owner-entry forms: the entry lands under Personal Log and `handoff.md` is never touched. `learn` merges a colliding title into a marked, reviewable region instead of overwriting hand-written content. The vault's repository-local CLI (`npm run heyloey`) still owns the global `--root` and `--show-paths` flags, so the two are not interchangeable yet — consolidating them is tracked in `docs/cli-unification-plan.md`.

---

## ⚙️ Configuration & Environment

| Variable | Description | Default |
| :--- | :--- | :--- |
| `LOEY_VAULT_ROOT` | **Required** by the launcher and server. Absolute path to the `loey_space` vault root. | None (must be supplied via env or `options.vault`) |
| `LOEY_CLI_PATH` | Path to compatible canonical `heyloey` CLI executable. | `$SCRIPT_DIR/canonical/heyloey.cjs` |
| `LOEY_SPACE_DIR` | Vault target handed to the canonical CLI; overrides the fallbacks below. | `$LOEY_VAULT_ROOT`, then `~/loey_space` |
| `LOEY_LOCK_DIR` | Directory holding the kernel lock files. Every writer must resolve the same one. | `/tmp/heyloey-locks` |
| `LOEY_LOCK_TIMEOUT_MS` | How long a writer waits for the kernel lock before exiting 7. | `15000` |
| `LOEY_SPACE_SYNTHETIC` | When set to `1`, forces CLI into synthetic test mode. | Unset |

---

## 📦 Directory Structure

```text
loey-space-mcp/
├── .github/workflows/ci.yml         # GitHub Actions CI on ubuntu-latest
├── bin/
│   └── loey-space-mcp               # Symlink-safe launcher resolving repo root & Node
├── canonical/
│   ├── heyloey.cjs                  # Verified canonical CLI with flock and lock-state support
│   └── package.json                 # Declares type: commonjs for canonical CLI
├── clients/
│   ├── antigravity/                 # Schemas (heyloey_done.json, read_text_file.json, etc.)
│   └── config.example.json          # Example client configurations
├── src/
│   ├── search-engine.cjs            # Single BM25/Porter/synonym engine (required by the CLI)
│   ├── hybrid-search.mjs            # ESM re-export wrapper over the same engine
│   └── safe-mcp.mjs                 # Hardened MCP server with note policy and canonical bridges
├── test/
│   ├── helpers/
│   │   ├── mock-vault.mjs           # Ephemeral vault fixture generator
│   │   └── mock-cli.cjs             # Mock CLI simulator
│   ├── test-safe-mcp.mjs            # 20 hermetic unit and regression tests
│   ├── test-integration.mjs         # 5 integration tests running canonical CLI in temp vault
│   ├── test-migrate-log.mjs         # 16 migrate-log separation, refusal and receipt tests
│   ├── test-install-hook.mjs        # 3 trailer-gated post-commit hook tests
│   ├── test-escaping-dedupe.mjs     # 3 escaping and exact-dedupe tests
│   └── test-search-engine.mjs       # 2 engine/CLI parity tests
├── hooks/
│   └── post-commit                  # Tracked source of the portable vault-milestone hook
├── tools/
│   ├── install-cli.mjs              # Idempotent installer for the installed `heyloey` command
│   └── install-hook.mjs             # Idempotent installer for the post-commit hook
├── docs/
│   └── cli-unification-plan.md      # Proposed consolidation of the CLI implementations
├── LICENSE                          # MIT
└── package.json
```

---

## 📥 Installing the `heyloey` command

The installed `heyloey` command is an installation artifact of `canonical/heyloey.cjs`. Never edit the installed copy; point it back at the repository instead:

```bash
npm run install:cli
```

The canonical CLI requires the shared engine at `src/search-engine.cjs` (resolved through the
script's real path). Keep `canonical/` and `src/` together: a copied, standalone
`heyloey.cjs` will refuse to start rather than run without an engine.

The installer links `~/.local/bin/heyloey` to this checkout's canonical CLI, so a single edit changes both the MCP bridge and the command you run by hand. It is safe to re-run:

- A correct symlink is a no-op; a repeat install writes nothing.
- An existing regular file is replaced only when it is byte-identical to the canonical artifact. A differing file is refused unless `--force` is given.
- A symlink pointing anywhere else is refused unless `--force` is given.
- Each replaced entry is preserved first, with its original mode, under `~/.local/state/heyloey/backups/`.
- The swap is a single atomic `rename`, and the result is verified before the command exits.
- Installation is refused from a temporary checkout or a disposable git worktree.
- `--dest <path>` installs elsewhere; `--dry-run` reports without writing.

If the checkout moves, the link breaks. Re-run the installer from the new location rather than recreating the command by hand.

---

## 🪝 Installing the vault-milestone post-commit hook

`hooks/post-commit` is the single tracked source of the hook that logs a milestone into the vault
when a commit carries a `HeyLoey-Milestone:` trailer. Install it into the user-level git template so
every new repository inherits it:

```bash
npm run install:hook
```

The target is `~/.git-template/hooks/post-commit`. `--repo <path>` installs into one existing
repository instead, resolving its hook directory through `git rev-parse --git-path hooks` so a
custom `core.hooksPath` is honoured. `--dry-run` reports without writing; `--help` lists the options.

What the hook guarantees, and why each part exists:

- **A commit is never blocked.** Every path exits 0. Only a commit whose message carries a non-empty
  `HeyLoey-Milestone:` trailer reaches the logger, and that call is bounded at 30 seconds.
- **A milestone is never lost to a read-only vault.** Before calling the CLI it probes the vault root,
  the month directory, the daily note and `handoff.md` for real writability. When any of them is
  unreachable — a read-only mount, a sandbox that scopes writes elsewhere — the milestone is queued
  in `.git/heyloey-milestones.pending` and exits 0, and the next commit that can write replays it
  through the same code path.
- **A replay lands in the day it happened.** Each queued record carries both its original UTC stamp
  (identity and ordering) and a `Pacific/Auckland` stamp (the vault calendar), and the replay passes
  the local stamp to `done --date`/`--time`. A milestone queued at 23:50 and replayed at 00:10 is
  filed in the previous day's note with its own time, instead of being claimed as today's work. A
  legacy two-field record has no local stamp, so it falls back to the older literal
  `[YYYY-MM-DD HH:MM] summary` prefix rather than inventing a day.
- **A replay never duplicates.** A record already present in the daily note is dropped instead of
  written twice, so a partial write or a hand-fix does not produce two rows.
- **A stale queue lock delays, never drops.** The lock is a bounded `mkdir`; if it is held, the record
  is still appended without it, because a short append is atomic and losing the milestone is the one
  unrecoverable outcome.

Installation is idempotent and non-destructive:

- A target already identical to the tracked hook is left alone (its executable bit is re-asserted, since
  git silently skips a non-executable hook).
- A target this installer did not write — anything without its marker line — is refused unless
  `--force` is given.
- The previous hook is copied to `~/.local/state/heyloey/hook-backups/<mirrored target path>.bak`
  before it is replaced, so two repositories never share one backup name. The backup is deliberately
  kept **outside** the template directory: git copies every file in a template's `hooks/` folder into
  each new repository, so a backup left there would end up in every future `.git/hooks`.
- The swap is a single atomic `rename`, so an interrupted install leaves either the old hook or the
  new one and never half of one.

Edit `hooks/post-commit` here, never an installed copy: the installed file is an artifact and a
re-image of the machine discards it.

---

## 🧪 Testing

The repository features nine suites, plus a script that runs them all (counts below are measured, not estimated):

1. **Hermetic Unit & Regression Suite** (20 tests, runs in CI without external dependencies):
   ```bash
   npm test
   ```
2. **Installer Safety Suite** (7 tests, exercises every install and refusal path in a temporary HOME):
   ```bash
   npm run test:install
   ```
3. **Post-commit Hook Suite** (3 tests: trailer gating, foreign-hook refusal, core.hooksPath):
   ```bash
   npm run test:hook
   ```
4. **Escaping & Dedupe Suite** (3 tests: HTML escaping in both records, exact-entry deduplication):
   ```bash
   npm run test:escaping
   ```
5. **Search-Engine Parity Suite** (3 tests: module/CLI parity and symlinked invocation):
   ```bash
   npm run test:search
   ```
6. **Migrate-Log Suite** (16 tests, covers area creation, explicit selection, ambiguous and unmatched refusals, dry-run and idempotency):
   ```bash
   npm run test:migrate
   ```
7. **Back-Dated Milestone Suite** (7 tests: named-day filing, an untouched `updated:` field, absent-day
   refusal, flag validation, dry-run preview and clock-time defaulting):
   ```bash
   npm run test:date
   ```
8. **Queue Replay Suite** (6 tests, drives the real hook body: queuing with a vault stamp, dated replay,
   legacy two-field replay, own-day dedupe, and re-queue on failure):
   ```bash
   npm run test:queue
   ```
9. **Integration Suite** (5 tests, runs real canonical CLI in temporary isolated mock vaults):
   ```bash
   npm run test:integration
   ```
10. **Run All** (78 tests total):
   ```bash
   npm run test:all
   ```

---

## 🔄 Client Reload Protocol

MCP servers run as persistent daemon child processes managed by client agents (e.g., Antigravity, Claude Desktop, Cursor, OpenCode).
> **Important**: Changing symlinks or updating files in this repository **does not reload live sessions**. To pick up changes, restart the host agent application or toggle the MCP server off and on.

---

## 📄 License

MIT — see [LICENSE](LICENSE).