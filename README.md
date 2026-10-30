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

**Command surface.** The canonical writer implements `brief`, `context`, `done`, `personal`, `learn`, `dream`, `log`, `handoff`, `status`, `lock-state`, `install-hook` and `migrate-log`. `migrate-log` normalises one daily note into its three labelled areas, folds bullets and a legacy callout into the single agent table, and moves a personal entry only when it is named with `--select` or `--select-summary`; it also accepts `--date` and `--dry-run`. `done --personal` is deliberately refused: `personal` is the only owner-entry path, and it never touches `handoff.md`. The vault's repository-local CLI (`npm run heyloey`) still owns the global `--root` and `--show-paths` flags, so the two are not interchangeable yet — consolidating them is tracked in `docs/cli-unification-plan.md`.

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
│   ├── test-migrate-log.mjs         # 12 migrate-log separation and refusal tests
│   ├── test-install-hook.mjs        # 3 trailer-gated post-commit hook tests
│   ├── test-escaping-dedupe.mjs     # 3 escaping and exact-dedupe tests
│   └── test-search-engine.mjs       # 2 engine/CLI parity tests
├── tools/
│   └── install-cli.mjs              # Idempotent installer for the installed `heyloey` command
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

## 🧪 Testing

The repository features seven suites, plus a script that runs them all:

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
5. **Search-Engine Parity Suite** (2 tests: module/CLI parity and symlinked invocation):
   ```bash
   npm run test:search
   ```
6. **Migrate-Log Suite** (12 tests, covers area creation, explicit selection, ambiguous and unmatched refusals, dry-run and idempotency):
   ```bash
   npm run test:migrate
   ```
7. **Integration Suite** (5 tests, runs real canonical CLI in temporary isolated mock vaults):
   ```bash
   npm run test:integration
   ```
8. **Run All** (52 tests total):
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
