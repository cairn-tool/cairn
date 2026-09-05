---
name: scripts-runner
description: Run a repository's named scripts with the cairn scripts toolset. Use when a task should invoke a project-defined command rather than a hardcoded one, when a script name needs resolving from a subdirectory, or when listing what scripts a repository declares.
---

# Running named scripts with cairn

`cairn` must be on `PATH`. Every command takes `--format llm|human|json` (`-fh`/`-fj`).

Longer conventions: [`./assets/cli-basics.md`](../../assets/cli-basics.md).

## What this is for

A script declared under `scripts:` in a `.cairn.yml` resolves **by name, from anywhere in the
repository**, and runs with its working directory pinned to the registry that declared it. That
is the whole point: a hook or a skill can call `cairn scripts run build` without knowing where it
is, and it keeps working after something changes directory.

## The three commands

```bash
cairn scripts list                    # what is available from here
cairn scripts which build             # which registry wins, and where it would run
cairn scripts run build               # run it
cairn scripts run lint -- --since main   # forward arguments
```

**Look before you run.** `scripts which <name>` reports the winning `.cairn.yml`, the working
directory the script would use, and any same-named definitions it shadows — without executing
anything. In a monorepo where a nested registry may override a root one, that is the difference
between running what you meant and running something else.

## Forwarding arguments

Arguments must follow a literal `--`. Everything after it is forwarded verbatim, including
tokens that would otherwise be read as `cairn`'s own options:

```bash
cairn scripts run lint-changed -- --since main
cairn scripts run echo-args -- -fj        # the script receives -fj, not cairn
```

For a `run:` body the arguments arrive as separate `argv` entries bound to `$1`…`$n`. **The shell
never re-reads them as source**, so an argument containing `; rm -rf ~` is one inert positional
parameter. You do not need to quote defensively on cairn's behalf.

A `run:` body that ignores its positional parameters while arguments were supplied is an error,
not a silent drop. If you see that, the body needs `"$@"`.

## Exit status passes through

In `llm` and `human` formats the script's stdout and stderr pass through untouched and **its exit
status becomes the command's exit status**. That is unlike every other `cairn` command, whose
codes are `0`/`1`/`2`. Report the script's real code; do not translate it.

With `--format json` the streams are captured into the payload instead, which is what you want
when you need to inspect output programmatically rather than show it.

`--ignore-exit-code` is the one way to turn the passthrough off: it exits `0` whatever happened,
including an unresolvable name. Reach for it only when a non-zero status would break the caller
rather than inform it — an invocation written inline in a skill document, where the loader reads
any non-zero status as a failure to load. Never in a hook or in CI, where the real code is the
point. The script's own code is still there as `exit.status` under `--format json`, so report
that rather than claiming the run succeeded.

## Resolution, briefly

Every `.cairn.yml` from the working directory up to the repository root is consulted, and the
**nearest file that defines the requested name** wins. A nested file that exists but does not
declare the name does not shadow an ancestor that does.

Two rules worth knowing because they produce confusing failures otherwise:

- **`node_modules` is skipped.** A vendored package's `.cairn.yml` can never win by being nearer.
- **Outside a Git repository, `scripts run` refuses** unless `--root` sets a boundary explicitly.
  `scripts which` and `scripts list` still report there, because reporting is not executing.

If a script does not resolve, run `cairn scripts list` first — the name may be declared above a
boundary you are inside of.

## Writing a registry

Declaring scripts, the `run:`/`exec:` choice, `cwd:`, and the environment a script receives are
in the `scripts-registry` skill.

## More

Full flags, the environment variables, and the trust boundary are in
[`reference/resolution.md`](reference/resolution.md).
