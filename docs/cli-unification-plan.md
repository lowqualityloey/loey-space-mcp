# CLI unification plan

Status: proposed; no installation or runtime changes applied.
Baseline: MCP commit `d6344a3`, inspected 18 October 2026.

## Outcome

Keep one authored full canonical CLI in this repository and make the installed
`heyloey` command delegate to it. An archive-schema fix should require one edit
and should be covered through both entry points.

## Current owners

| Entry point | Current implementation | Role |
| --- | --- | --- |
| MCP launcher `bin/loey-space-mcp` | `canonical/heyloey.cjs` by default | Restricted agent interface |
| Installed `~/.local/bin/heyloey` | Separate full script | Owner's CLI |
| Vault `npm run heyloey` | `06-Resources/scripts/src/heyloey.ts` and generated bundle | Portable repository CLI, including dry-run and learned-note merging |

The first two implementations currently compare byte-for-byte equal. The vault's
TypeScript CLI has its own implementation and behavior; its future integration
needs a separate command/contract inventory. A fresh vault clone must remain
usable without a private MCP checkout.

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

Add an idempotent installation command here that points
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

Run installation only when the client is idle. This plan does not authorize or
perform that installation.

## Step 3: Verify the installed result

1. Confirm both entry points resolve to the same canonical artifact.
2. Run the MCP package's full suite and the installed-entry-point regressions.
3. Use synthetic temporary vaults for milestone, overflow, duplicate retry,
   missing-record and cross-entry-point concurrency checks.
4. Verify the owner's actual vault only with read-only `lock-state` and MCP
   initialization/tool listing. Do not add test milestones to owner records.
5. Check that no server boundary, client root or unrelated vault file changed.

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

The proposed next implementation task is steps 1-3 for the two equal full CLI
copies. Repository CLI consolidation, dependency upgrades and other enhancement
work remain separate tasks. No commits or pushes are part of this plan.
