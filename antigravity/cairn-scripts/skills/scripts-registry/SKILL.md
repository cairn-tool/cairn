---
name: scripts-registry
description: Author the scripts block in a .cairn.yml registry for the cairn scripts toolset. Use when adding or changing a named script, choosing between a shell body and an argv array, or deciding where a script should run from.
---

# Declaring scripts in `.cairn.yml`

Longer CLI conventions: [`./assets/cli-basics.md`](../../assets/cli-basics.md).

## Shape

```yaml
version: 1
scripts:
  gather-context:
    description: Collect repository context for the planning skill
    run: ./scripts/gather-context.sh "$@"
  lint-changed:
    exec: ["npm", "run", "lint"]
    cwd: registry
```

Exactly one of `run:` and `exec:` is required.

| Key           | Meaning                                                                      |
| ------------- | ---------------------------------------------------------------------------- |
| `run`         | A shell body. Forwarded arguments arrive as `$1`…`$n`; `"$@"` forwards them. |
| `exec`        | An argv array run with **no shell**. Forwarded arguments are appended.       |
| `shell`       | Shell for `run:`; defaults to `/bin/sh`. Ignored for `exec:`.                |
| `cwd`         | `registry` (default), `invocation`, or a registry-relative path.             |
| `description` | Shown by `scripts list` and `scripts which`.                                 |

## Choosing `run:` or `exec:`

**Prefer `exec:`** when you are invoking a program with fixed arguments. No shell means nothing
to quote and nothing to escape.

**Use `run:`** when you genuinely need shell features — a pipeline, a conditional, a loop. Then
end the body with `"$@"` if it should accept forwarded arguments.

Never interpolate a forwarded argument into a `run:` body. Arguments are already bound to
`$1`…`$n` as inert positional parameters; writing them into the body text is what would make
them lexable again.

## `run:` uses `/bin/sh`, not `$SHELL`

Deliberately. A login shell may be `fish` or `csh`, neither of which binds positional parameters
for `-c`, so honoring `$SHELL` would make a committed registry behave differently per machine —
the exact problem this toolset exists to solve.

A body needing `set -o pipefail` or another bashism sets `shell: /bin/bash` explicitly.

## `cwd:` decides where relative paths land

| Value                | The script runs in                             |
| -------------------- | ---------------------------------------------- |
| `registry` (default) | The directory holding the winning `.cairn.yml` |
| `invocation`         | Wherever the caller was                        |
| a relative path      | Resolved from the registry directory           |

`registry` is the default because it is what makes a name resolve identically from anywhere. Use
`invocation` only when the script's whole job is to act on the caller's location.

A resolved `cwd` outside the repository boundary is refused.

## The environment a script receives

| Variable                | Value                                      |
| ----------------------- | ------------------------------------------ |
| `CAIRN_SCRIPT_NAME`     | The resolved name                          |
| `CAIRN_SCRIPT_ROOT`     | Directory of the registry that declared it |
| `CAIRN_SCRIPT_REGISTRY` | The registry file itself                   |
| `CAIRN_INVOKED_FROM`    | The directory the command was invoked from |

Each is also exported under its pre-rename `CLAUDE_CLI_*` spelling. A script needing the caller's
location reads `CAIRN_INVOKED_FROM` rather than `pwd`.

A script that re-enters `scripts run` on itself fails immediately, and nesting is refused past
eight levels. That is a footgun guard, not a security control.

## Validation happens early

`loadConfig` validates the `scripts:` block on **every** `md` command in that workspace, so a typo
surfaces at `cairn md lint` rather than as a surprise at `scripts run`. If an `md` command starts
failing after you edit a registry, the registry is why.

## The trust boundary

What makes executing acceptable is that the command is declared by name in a **tracked file**,
not discovered in content being analyzed. This is a resolver, not an evaluator.

A registry sits at the same trust level as a `Makefile` or a `package.json` `scripts` block:
anyone who can commit a `.cairn.yml` into a tree can already commit a Git hook. The boundary rule,
the `node_modules` skip, and the containment checks narrow the blast radius; they do not make an
untrusted tree safe to run in.

`scripts run` is never exposed by `cairn serve`. That server is read-only, and process execution
has no place behind it.
