# `scripts which`

## Synopsis

```text
cairn scripts which <name> [options]
```

Reports which `.cairn.yml` defines a script for the current working directory, and where
that script would run — without executing anything. This is the command to reach for when a
hook runs the wrong thing and you need to see which registry won.

## Arguments

| Argument | Required | Description                            |
| -------- | -------- | -------------------------------------- |
| `name`   | Yes      | Script name declared under `scripts:`. |

## Options

| Option            | Default         | Description                                          |
| ----------------- | --------------- | ---------------------------------------------------- |
| `--format <fmt>`  | `llm`           | `llm`, `human`, or `json`. Not configurable.         |
| `--envelope`      | `false`         | Wrap `--format json` output in the result envelope.  |
| `--root <dir>`    | Repository root | Stop the upward walk at this directory.              |
| `--config <file>` | Discovered      | Use one specific registry and skip the walk.         |
| `--no-config`     | —               | Disable discovery; every name then fails to resolve. |
| `-h`, `--help`    | —               | Show help.                                           |

## What it reports

The winning registry, the working directory the script would run in, the command it would run,
and any same-named definitions the winner shadows. `--format json` additionally reports every
file the walk opened, each with its distance from the working directory and one of:

| Status       | Meaning                                                      |
| ------------ | ------------------------------------------------------------ |
| `defines`    | Declares the requested name — the winner, or a shadowed one. |
| `declares`   | Parsed, with a `scripts:` block that lacks the name.         |
| `no-scripts` | Parsed, with no `scripts:` block at all.                     |
| `invalid`    | Unreadable YAML, or a `scripts:` block that failed to parse. |
| `skipped`    | Failed a read guard, or sits under `node_modules`.           |

Unlike [`scripts list`](scripts-list.md), an `invalid` file nearer than the winner is an error
rather than a note: it might have defined the name, so the answer cannot be trusted.

Resolution is identical to [`scripts run`](scripts-run.md) with one exception — outside a Git
repository this command still reports, because reporting is not executing.

## Exit codes

| Condition              | Code | Stream |
| ---------------------- | ---- | ------ |
| The name resolved      | `0`  | stdout |
| Invocation error       | `1`  | stderr |
| No script by that name | `2`  | stderr |

## Related surfaces

- [`scripts run`](scripts-run.md) executes what this command resolves.
- [`scripts list`](scripts-list.md) answers the same question for every visible name at once.
