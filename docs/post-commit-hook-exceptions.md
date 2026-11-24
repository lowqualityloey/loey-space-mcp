# Post-commit hook exception: oct-project

**Status:** intentional; do not replace during a template sweep. Recorded 2026-11-24.

The following four working copies are deliberately kept on the older post-commit hook
(`f3296ac84da076224eff913d3fccc3716818798cf8a3d3440271f6d73e210bde`):

- `~/personal/oct-project/deal-radar/.git/hooks/post-commit`
- `~/personal/oct-project/fastdesk/.git/hooks/post-commit`
- `~/personal/oct-project/recipebox/.git/hooks/post-commit`
- `~/personal/oct-project/supplywatch/.git/hooks/post-commit`

## Why they stay legacy

The legacy hook and the merged hook are not drop-in equivalents for these repositories:

- **Vault target:** the legacy hook defaults to
  `%USERPROFILE%/Documents/loey_space`. All four repos have `heyloey.vault` unset, so the merged
  hook would fall back to each repository root instead of the vault.
- **CLI discovery:** the legacy hook prepends `~/.local/bin` and `~/.cargo/bin` to `PATH` and
  prefers `~/.local/bin/heyloey`. The merged hook never modifies `PATH`; in a non-login WSL shell,
  `heyloey` is not on `PATH`, so the merged hook would silently find no logger.
- **Intentional diagnostics:** the legacy hook supports `LOEY_HOOK_VERBOSE=1`, has specific
  messages for lock exits 7/8/9, writes `${TMPDIR:-/tmp}/heyloey-post-commit.log`, and allows a
  20-second logger run. The merged hook has a different log location, generic lock reporting, and
  a 10-second default bound.

The merged hook's queue, replay, ledger, and coordination features are useful, but they do not
justify changing the vault target or making logging disappear in these four checkouts.

## Upgrade checklist, when the exception is revisited

Do not replace the hooks until every step has been completed and tested:

1. In each repo, set the vault explicitly:
   `git config heyloey.vault <vault-root>` (the Windows vault is
   `%USERPROFILE%/Documents/loey_space`; from WSL use its mounted path).
2. Make the CLI discoverable. Prefer the new explicit option:
   `git config heyloey.cli "$HOME/.local/bin/heyloey"`.
   It must name an executable file; an unusable path is reported and the hook skips logging rather
   than choosing a different CLI. On Windows Git Bash, use `LOEY_WSL_CLI` for the CLI path inside WSL.
3. Decide whether to preserve `LOEY_HOOK_VERBOSE`, the `/tmp` log path, and the detailed exit 7/8/9
   messages. Set `heyloey.timeout 20` if the legacy bound is required.
4. Install into one repo, make a milestone commit, and verify the daily note, `handoff.md`, queue
   behavior, and log output before rolling out the other three.

## Template-sweep rule

Skip the four paths above. `tools/install-hook.mjs` normally refuses an unmarked legacy hook without
`--force`; never pass `--force` for these paths. A fresh template install does not change existing
repository hooks, so documenting the exception here is the guard against a future sweep.
