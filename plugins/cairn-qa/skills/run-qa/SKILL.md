---
name: run-qa
description: Run this repository's pending test-case queue with cairn qa.
invocationPolicy: explicit
argumentHint: "[runs-dir] [--only tc-N,tc-M] [--dry-run]"
---

# Run the test-case queue

Run the pending cases in `$ARGUMENTS`.

1. If no runs directory is given, check `.cairn.yml` for `qa.runs-dir`. If neither names one, run
   `cairn qa list` and show what it finds, or say plainly that there is nothing to run.
2. Run `cairn qa list --repo . --runs-dir <dir>` first and show what is pending versus done. Say how
   many cases will launch and on which backends before launching any of them.
3. **`qa run` spawns agents with permission checks bypassed.** If the plans are not the user's own,
   or you have not read them, run `cairn qa run --repo . --runs-dir <dir> --dry-run` and stop there
   for confirmation.
4. Otherwise run `cairn qa run --repo . --runs-dir <dir>`, forwarding `--only` and `--limit` from
   `$ARGUMENTS`.

Exit `2` means the queue ran and a case did not pass — report which case and why, from `summary.md`.
It does not mean the command failed.
