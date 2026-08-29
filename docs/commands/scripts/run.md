# `scripts run`

## Synopsis

```text
cairn scripts run <name> [-- args...] [options]
```

Runs a script declared under `scripts:` in a `.cairn.yml`, resolved by name rather than by
path. The name resolves the same from every directory in the repository, and the script runs
with its working directory pinned to the registry that declared it — which is what lets a hook
or a skill keep working after the calling process changes directory.

This is the only command in the tool that executes anything. See
[the trust boundary](#the-trust-boundary) for what that does and does not guarantee.

## Arguments

| Argument | Required | Description                                                    |
| -------- | -------- | -------------------------------------------------------------- |
| `name`   | Yes      | Script name declared under `scripts:`.                         |
| `args`   | No       | Arguments forwarded to the script. Must follow a literal `--`. |

## Options

| Option            | Default         | Description                                          |
| ----------------- | --------------- | ---------------------------------------------------- |
| `--format <fmt>`  | `llm`           | `llm`, `human`, or `json`. Not configurable.         |
| `--envelope`      | `false`         | Wrap `--format json` output in the result envelope.  |
| `--root <dir>`    | Repository root | Stop the upward walk at this directory.              |
| `--config <file>` | Discovered      | Use one specific registry and skip the walk.         |
| `--no-config`     | —               | Disable discovery; every name then fails to resolve. |
| `-h`, `--help`    | —               | Show help.                                           |

`scripts` commands accept no `commands:` defaults in `.cairn.yml`. A checked-in
configuration file may declare what a script _is_, but must never be able to change how it is
invoked.

## Resolution

Every `.cairn.yml` from the working directory up to the boundary is consulted, and the
nearest file that **defines the requested name** wins. A nested file that exists but does not
declare the name does not shadow an ancestor that does, so per-package overrides work without
a nested registry having to redeclare everything above it.

The walk stops at the repository root, or at `--root` when it is deeper. Files under
`node_modules` are skipped: nearest-wins is the feature, and a vendored package shipping its own
`.cairn.yml` is where that would otherwise become a supply-chain hole.

Outside a Git repository there is no boundary to stop at, so `scripts run` refuses unless
`--root` sets one explicitly. Without that rule the walk would fall back to the nearest
configuration file, which in a scratch directory can mean a world-writable one in a shared
parent. [`scripts which`](which.md) and [`scripts list`](list.md) still report
there, because reporting is not executing.

A file nearer than the winner that cannot be read is an error rather than a skip — it might
have defined the name, and running the wrong script is the failure this design exists to
prevent. A malformed file _farther_ than the winner cannot change the answer and is reported
without failing.

## Declaring a script

```yaml
version: 1
scripts:
  gather-context:
    description: Collect repository context for the planning skill
    run: ./.claude/scripts/gather-context.sh "$@"
  lint-changed:
    exec: ["npm", "run", "lint"]
    cwd: registry
```

Exactly one of `run` and `exec` is required.

| Key           | Description                                                                    |
| ------------- | ------------------------------------------------------------------------------ |
| `run`         | A shell body. Forwarded arguments arrive as `$1`…`$n`, and `$@` forwards them. |
| `exec`        | An argv array run with no shell. Forwarded arguments are appended.             |
| `shell`       | Shell for `run`; defaults to `/bin/sh`. Applies to `run` only.                 |
| `cwd`         | `registry` (default), `invocation`, or a registry-relative path.               |
| `description` | Shown by `scripts list` and `scripts which`.                                   |

`run` uses `/bin/sh` rather than `$SHELL`, so a registry behaves the same on every machine —
a login shell may be `fish` or `csh`, neither of which binds positional parameters for `-c`.
Set `shell: /bin/bash` for a body that needs `set -o pipefail` or other bashisms.

## Forwarding arguments

Arguments must follow a literal `--`, and everything after it is forwarded verbatim — including
tokens that would otherwise be read as this command's own options:

```bash
cairn scripts run lint-changed -- --since main
cairn scripts run echo-args -- -fj      # the script receives -fj
```

For `run`, the arguments are handed to the shell as separate `argv` entries and bound to `$1`…`$n`.
**The shell never re-reads them as source**, so an argument containing `; rm -rf ~` is one inert
positional parameter. A `run` body that ignores its positional parameters while arguments were
supplied is an error rather than a silent drop; add `"$@"` to forward them.

## The environment a script receives

| Variable                | Value                                       |
| ----------------------- | ------------------------------------------- |
| `CAIRN_SCRIPT_NAME`     | The resolved name.                          |
| `CAIRN_SCRIPT_ROOT`     | Directory of the registry that declared it. |
| `CAIRN_SCRIPT_REGISTRY` | The registry file itself.                   |
| `CAIRN_INVOKED_FROM`    | The directory the command was invoked from. |

A script that genuinely needs the caller's location reads `CAIRN_INVOKED_FROM` rather than
`pwd`. A nested `cairn` also inherits `CAIRN_NO_UPDATE_NOTIFIER=1`, so it cannot write
an update notice into output the calling hook is capturing.

A script that re-enters `scripts run` on itself fails immediately, and nesting is refused past
eight levels. That is a footgun guard, not a security control — a script can clear either
variable.

## The trust boundary

What makes executing acceptable here is that the command is declared by name in a tracked file
inside the workspace, not discovered in content being analyzed. This is a resolver, not an
evaluator. The registry is at the same trust level as a `Makefile` or a `package.json`
`scripts` block: **anyone who can commit a `.cairn.yml` into your tree can already commit
a Git hook.** The boundary rule, the `node_modules` skip, and the containment checks narrow the
blast radius; they do not make an untrusted tree safe to run in.

Concretely, the guards are: the winning registry must resolve inside the boundary, through
symlinks; it must be a regular file under 1 MiB with no NUL bytes; and a script's resolved
working directory must also stay inside the boundary, since `cwd` is what decides where the
script's own relative paths land.

`scripts run` is never exposed by [`serve`](../serve.md). That server is documented as read-only,
and process execution has no place behind it.

## Exit codes

| Format         | Condition                                   | Code           | Stream |
| -------------- | ------------------------------------------- | -------------- | ------ |
| `llm`, `human` | The script ran                              | Its own status | —      |
| `llm`, `human` | The script was killed by a signal           | `128 + signal` | —      |
| Any            | Unresolvable name, refused boundary         | `1`            | stderr |
| Any            | The script could not be started at all      | `1`            | stdout |
| `json`         | The script exited `0`                       | `0`            | stdout |
| `json`         | The script exited non-zero or was signalled | `2`            | stdout |

In `llm` and `human` formats the child inherits all three streams and this command writes
nothing of its own to stdout, so a hook's captured output is exactly the script's. **The exit
status is the script's, verbatim** — outside the tool's usual `0`/`1`/`2`, which is why
`describe` reports it separately under `exitCodePassthrough`.

`--format json` captures the streams into the payload instead, and the payload goes to stdout in
every outcome, including a failed script, so a consumer never has to switch streams. A script
that never _started_ — a missing program, a permission error — exits `1` rather than `2`, so a
typo in `exec[0]` stays distinguishable from a legitimately failing test suite.

## Related surfaces

- [`scripts which`](which.md) shows which registry would win, without running anything.
- [`scripts list`](list.md) shows every name visible from the working directory.
- [Project configuration](../../configuration.md) documents the `scripts:` block alongside the
  rest of `.cairn.yml`.
