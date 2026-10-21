# 🧠 loey-space-mcp

Hardened Model Context Protocol (MCP) server providing external coding agents with safe, read-only access to `loey_space` notes and a single kernel-locked milestone mutation path.

---

## 🛡️ Security Model & Architecture

- **Field Engineer vs. Chief-of-Staff Boundary**: External coding agents cannot perform generic markdown writes or scaffold daily notes. The vault curator agent owns general curation.
- **Strict Read-Only Enforcement**: Ordinary note tools (`read_text_file`, `list_directory`, `get_file_info`, `list_allowed_directories`) deny private directories (`00-Private/`, `05-Personal/`, `.secrets/`, `.git/`, `.env`) and reject directory traversal (`../`) or symlink escapes.
- **Zero-Dependency Hybrid Context Retrieval**: `heyloey_context` combines Laya System-1 classification with a pure-JS BM25 ranker, Porter English stemmer, and technical synonym expansion over `03-Dev/` and `08-Concepts/`. It executes in $<1$ms in-memory with zero native C++ bindings.
- **Single Locked Mutation Path**: `heyloey_done` and `heyloey_learn` are the sole mutation tools. They delegate to the companion canonical CLI (`heyloey`) under util-linux kernel locks (`flock`).
- **Lossless Paging**: `read_text_file` provides windowed line paging (`head`, `offset`) and character continuation (`char_offset`), guaranteeing 100% exact source reconstruction across long-line cutoffs and blank-line boundaries.
- **Process Group Isolation**: Spawns CLI tasks detached and discovers all descendant process groups via `/proc`. If a process hangs, saturates pipe buffers (>128 KB), or times out, the entire process tree (including detached `flock` and grandchild writers) is cleanly reaped with `SIGKILL`.

---

## 🐧 Platform & Runtime Support

- **Operating System**: **Linux** or **WSL2** (Windows Subsystem for Linux).
  > **Note**: Runtime process reaping requires the Linux `/proc` virtual filesystem, and vault concurrency requires util-linux `flock`. It is not supported on bare Windows or macOS without containerization.
- **Runtime**: Node.js **>= 20.0.0** (tested on Node 20, 22, and 24).

---

## 🔗 Canonical CLI Dependency Contract

`loey-space-mcp` is an interface boundary and relies on a compatible canonical `heyloey` CLI implementation (such as `canonical/heyloey.cjs` or `/home/heyloey/.local/bin/heyloey`):
- **Exit 0**: `RESULT done logged` — milestone recorded in today's daily note and `handoff.md`.
- **Exit 3**: `RESULT done skipped` — synthetic test run (`LOEY_SPACE_SYNTHETIC=1`), nothing written.
- **Exit 4**: `RESULT done refused` — required daily note or handoff record is missing.
- **Exit 7**: Lock contention timed out.
- **Exit 8**: Lock unavailable (e.g. missing `flock`).

---

## ⚙️ Configuration & Environment

| Variable | Description | Default |
| :--- | :--- | :--- |
| `LOEY_VAULT_ROOT` | **Required**. Absolute path to the `loey_space` vault root. | None (must be supplied via env or `options.vault`) |
| `LOEY_CLI_PATH` | Path to compatible canonical `heyloey` CLI executable. | `$SCRIPT_DIR/canonical/heyloey.cjs` |
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
│   ├── hybrid-search.mjs            # Pure-JS BM25 ranker, Porter stemmer, and synonym expansion
│   └── safe-mcp.mjs                 # Hardened MCP server with note policy and canonical bridges
├── test/
│   ├── helpers/
│   │   ├── mock-vault.mjs           # Ephemeral vault fixture generator
│   │   └── mock-cli.cjs             # Mock CLI simulator
│   ├── test-safe-mcp.mjs            # 20 hermetic unit and regression tests
│   └── test-integration.mjs         # 5 integration tests running canonical CLI in temp vault
└── package.json
```

---

## 🧪 Testing

The repository features two test suites:

1. **Hermetic Unit & Regression Suite** (20 tests, runs in CI without external dependencies):
   ```bash
   npm test
   ```
2. **Integration Suite** (5 tests, runs real canonical CLI in temporary isolated mock vaults):
   ```bash
   npm run test:integration
   ```
3. **Run All** (25 tests total):
   ```bash
   npm run test:all
   ```

---

## 🔄 Client Reload Protocol

MCP servers run as persistent daemon child processes managed by client agents (e.g., Antigravity, Claude Desktop, Cursor, OpenCode).
> **Important**: Changing symlinks or updating files in this repository **does not reload live sessions**. To pick up changes, restart the host agent application or toggle the MCP server off and on.
