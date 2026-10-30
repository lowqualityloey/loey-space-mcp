# CLI unification plan

Status: applied. Since 27 October 2026 the installed command is a symlink to
`canonical/heyloey.cjs`, installed by `npm run install:cli`; the pointer can be
re-established idempotently at any time.
Baseline: MCP commit `d6344a3`, inspected 18 October 2026.

## Outcome

Keep one authored full canonical CLI in this repository and make the installed
`heyloey` command delegate to it. An archive-schema fix should require one edit
and should be covered through both entry points.

## Current owners

| Entry point | Current implementation | Role |
| --- | --- | --- |
| MCP launcher `bin/loey-space-mcp` | `canonical/heyloey.cjs` by default | Restricted agent interface |
| Installed `~/.local/bin/heyloey` | Symlink to `canonical/heyloey.cjs` (applied 27 Oct 2026) | Owner's CLI |
| Vault `npm run heyloey` | `06-Resources/scripts/src/heyloey.ts` and generated bundle | Portable repository CLI, including dry-run and learned-note merging |

The installed command and the MCP launcher now resolve to the same artifact, so
they cannot drift. The vault's TypeScript CLI has its own implementation and
behavior; its future integration needs a separate command/contract inventory.
A fresh vault clone must remain usable without a private MCP checkout.

## Step 1: Pin the behavior before changing installation

The new integration test in `test/test-integration.mjs` starts the package
launcher over stdio and calls `heyloey_done` against an ephemeral vault. Fourteen
existing handoff items plus the new milestone must leave ten live items and five
archived items. The archive must declare `type: review` and `kind: archive`, with
every original milestone preserved exactly once. Removing the classification
must fail this test.

Before a later installation change, add a companion temporary-symlink test for
the installed CLI entry point. Require the same archive, refusal, idempotency
and RESULT behavior, and concurrent writes through the two entry points that
preserve every milestone under the same resolved-vault flock identity.

## Step 2: Make the installed command an owned pointer

Implemented as `npm run install:cli` (`tools/install-cli.mjs`), which points
`~/.local/bin/heyloey` at this checkout's `canonical/heyloey.cjs`.

- Resolve the permanent checkout path; never install a link to a temporary test
  clone or disposable worktree.
- Inspect an existing command without following it into an unrelated file.
  Accept an already-correct link. For a regular file, compare it with the
  canonical artifact before replacing it; refuse unexpected differing content.
- Preserve the original file and mode in a uniquely created private backup
  outside Git, then replace the installed command atomically.
- Keep vault selection, arguments, exit codes and RESULT receipts unchanged.
  Keep explicit `LOEY_CLI_PATH` overrides supported; inventory configured
  overrides before rollout rather than silently changing their targets.
- Document the single editing owner: `canonical/heyloey.cjs`. The installed
  command is an installation artifact, not a second editable source.

The pointer was first applied by hand on 27 October 2026 with the client idle,
then reproduced by `npm run install:cli`: the original file and its mode are
preserved under `~/.local/state/heyloey/backups/`, and the swap is atomic.
Re-running the installer against the current install is a no-op.

## Step 3: Verify the installed result

1. Confirm both entry points resolve to the same canonical artifact.
2. Run the MCP package's full suite and the installed-entry-point regressions.
3. Use synthetic temporary vaults for milestone, overflow, duplicate retry,
   missing-record and cross-entry-point concurrency checks.
4. Verify the owner's actual vault only with read-only `lock-state` and MCP
   initialization/tool listing. Do not add test milestones to owner records.
5. Check that no server boundary, client root or unrelated vault file changed.

Applied check (27 October 2026): both entry points resolve to the same artifact;
the full suite passes with `LOEY_CLI_PATH` pointing at the installed symlink; and
read-only `lock-state` confirms vault selection and `LOEY_SPACE_DIR` precedence.
No owner records were written during verification. `test/test-install-cli.mjs`
covers fresh install, no-op re-run, identical-file replacement, both refusal
paths, `--force`, `--dry-run` and temporary-checkout refusal.

## Rollback

If any installation check fails, atomically restore the backed-up installed
command with its original mode. Re-run read-only lock diagnostics and the
temporary-vault checks. Keep the versioned canonical source and backup intact;
do not reset repositories or edit vault records to repair installation state.

## Later decision: repository CLI integration

After the installed/MCP ownership change is stable, inventory the TypeScript
CLI against the canonical implementation, including root precedence, read-only
commands, dry-run, `learn`, archive overflow, result statuses, partial-write
recovery and shutdown behavior. Use that matrix to decide a portable shared
core and reproducible distribution strategy. Avoid a runtime dependency from
public vault clones on an owner's absolute path or private repository.

`migrate-log` was ported to the canonical CLI on 27 October 2026, with
`test/test-migrate-log.mjs` covering area creation, explicit selection, ambiguous
and unmatched refusals, dry-run and idempotency. The remaining differences are the
vault CLI's global `--root` and `--show-paths` flags, and the `done --personal`
shorthand that the canonical writer deliberately refuses.

The proposed next implementation task is steps 1-3 for the two equal full CLI
copies. Repository CLI consolidation, dependency upgrades and other enhancement
work remain separate tasks. No commits or pushes are part of this plan.

## Inventory: canonical vs repository CLI (30 October 2026)

| Surface | `canonical/heyloey.cjs` | `06-Resources/scripts/src/heyloey.ts` |
| --- | --- | --- |
| Commands | brief, context, done, milestone, personal, learn, dream/prune, log/sync, handoff/save, status, lock-state, install-hook, migrate-log | brief, context, done, learn, personal, migrate-log, lock-state |
| `--root <dir>` | **added 30 Oct**; wins over LOEY_SPACE_DIR / LOEY_VAULT_ROOT | supported; defaults to the working directory |
| `--show-paths` | no | yes (relative paths by default) |
| `--dry-run` | `migrate-log` only | every writing command, with a line-level preview |
| `done --personal` | refused by design | supported (personal log, handoff untouched) |
| `learn` collision | no marked-region merge | merges into a marked region instead of overwriting |
| Default target | LOEY_SPACE_DIR → LOEY_VAULT_ROOT → `~/loey_space` | `--root`, else the working directory |
| Output | `[heyloey]` machine lines + `RESULT` receipt | human/emoji output, relative paths |
| Lock | kernel `flock` | kernel `flock` (same protocol) |

The copies are NOT equal: the repository CLI is a distinct UX with extra flags and a
different default target. Unification therefore chooses one surface, not just one file.

### Target (recommended)

`canonical/heyloey.cjs` is the only implementation. The vault keeps a **vendored copy** at
`06-Resources/scripts/heyloey.js` generated from canonical, so a fresh clone stays portable
without this private checkout. The TypeScript source and its bundling are retired after the
vault's CLI tests pass against the vendored copy. Vault-only flags become canonical flags.

### Remaining work before the swap

1. Port `--show-paths`, global `--dry-run` (done/log/handoff/learn), and `learn` marked-region
   merging; decide whether `done --personal` is accepted or the vault docs move to `personal`.
2. Decide the default target: keep canonical's environment/home default (vault script passes
   `--root .`) or adopt the working-directory default everywhere.
3. Choose the surviving output style (canonical machine lines vs vault human/emoji).
4. Add a parity conformance test running the same scenarios through both CLIs; it is the swap gate.
5. Update vault tests, README/AGENTS command tables, and the post-commit call if arguments change.
6. Retire `src/heyloey.ts` and its build wiring only once the vault suite is green.

### Rollback

Restore the vault files from git; the canonical additions are additive. The swap itself
touches no vault records.


### Progress (30 October 2026)

Landed on canonical: `--root`, global `--dry-run` for every writing command, `--show-paths`
(preview paths), `done --personal` (propagated into the flocked child), and `learn` merging
into a marked region instead of overwriting. Covered by `test/test-cli-root.mjs` and
`test/test-dry-run.mjs`; suite is 60 tests.

Still open before the swap: the default-target difference (the vault npm script must pass
`--root .`), a parity conformance run of the vault's own CLI tests against the vendored
canonical copy, and the retirement of `src/heyloey.ts` (needs explicit scoped confirmation).
