# `scripts list`

## Synopsis

```text
cairn scripts list [options]
```

Lists every script name visible from the working directory, after nearest-definition-wins has
been applied. One entry per name, naming the registry that won and the files it shadows.

## Options

| Option            | Default         | Description                                         |
| ----------------- | --------------- | --------------------------------------------------- |
| `--format <fmt>`  | `llm`           | `llm`, `human`, or `json`. Not configurable.        |
| `--envelope`      | `false`         | Wrap `--format json` output in the result envelope. |
| `--root <dir>`    | Repository root | Stop the upward walk at this directory.             |
| `--config <file>` | Discovered      | List one specific registry and skip the walk.       |
| `--no-config`     | —               | Disable discovery; the listing is then empty.       |
| `-h`, `--help`    | —               | Show help.                                          |

## What it reports

Names are sorted by byte comparison, not by locale, so the listing is stable across machines. A
name declared in more than one registry appears once, resolved to the nearest definition, with
the losing files recorded under `shadows` rather than listed separately — the listing answers
"what will run", not "what exists".

Files that could not be parsed are **reported rather than skipped**, and make the command exit
`2`. A listing that silently omitted a file would read as complete, which is the one thing it
must never do. This is where it differs from [`scripts which`](which.md), which fails
outright when an unreadable file could have shadowed its answer: a listing has no single answer
to protect, so it prints what it has and flags what it could not read.

Like `scripts which`, this command reports outside a Git repository, where
[`scripts run`](run.md) refuses.

## Exit codes

| Condition                                        | Code | Stream |
| ------------------------------------------------ | ---- | ------ |
| Listing written                                  | `0`  | stdout |
| Invocation error                                 | `1`  | stderr |
| A consulted configuration file could not be read | `2`  | stderr |

## Related surfaces

- [`scripts which`](which.md) explains one name in detail, including every file consulted.
- [`scripts run`](run.md) executes a listed name.
- [Project configuration](../../configuration.md) documents the `scripts:` block.
