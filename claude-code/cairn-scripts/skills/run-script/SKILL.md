---
name: run-script
description: Run a named script from this repository's .cairn.yml.
disable-model-invocation: true
argument-hint: <name> [-- args...]
---

# Run a named script

Run the script named in `$ARGUMENTS`.

1. If `$ARGUMENTS` is empty, run `cairn scripts list` and show what is available.
2. Otherwise run `cairn scripts which <name>` first and show which registry wins and where the
   script would run. In a monorepo a nested registry may shadow the one you expect.
3. Then run `cairn scripts run <name>`, forwarding any arguments after a literal `--`.

The script's exit status passes through as the command's own. Report the real code rather than
translating it into pass/fail.
