# `agent add`

## Synopsis

```text
cairn agent add <kind> <name> [bundle] [options]
```

Adds exactly one component to an existing bundle. Like [`agent init`](init.md) it never
prompts, supports `--dry-run`/`--check`, and reports a machine-readable plan, so an agent can
use it without parsing output.

**Stability: experimental.** The payload shape may change before it hardens.

## The manifest is left alone unless it has to change

`agent add` writes `agent-bundle.yaml` **only** when the component cannot be discovered at its
default location — in practice, only when `--path` names a non-default root. In every other
case the manifest is byte-untouched.

When an edit is required it goes through a comment-preserving YAML document, so comments and
key order survive. Incidental whitespace is still normalized (`name: demo  # x` becomes
`name: demo # x`), and that is reported as `AB203` rather than happening silently.

## Arguments

| Argument | Required | Description                                                                  |
| -------- | -------- | ---------------------------------------------------------------------------- |
| `kind`   | Yes      | `skill`, `agent`, `rule`, `hook`, `policy`, `mcp`, or `overlay`.             |
| `name`   | Yes      | Component name in kebab-case. For `hook`, a **portable event name** instead. |
| `bundle` | No       | Bundle root. Defaults to `.`.                                                |

Portable hook events are `session-start`, `pre-tool-use`, `post-tool-use`, and `stop`. A hook
is keyed by its event, so any other name is refused — it would render to a hook no target can
map.

## Options

| Option                 | Default      | Description                                                             |
| ---------------------- | ------------ | ----------------------------------------------------------------------- |
| `--description <text>` | Generated    | Component description.                                                  |
| `--path <dir>`         | Default root | Component root override. This is the case that edits the manifest.      |
| `--activation <mode>`  | `always`     | Rule activation: `always`, `files`, `model`, `manual`.                  |
| `--glob <glob>`        | None         | Repeatable rule glob. Pair with `--activation files`.                   |
| `--command <cmd>`      | Generated    | Command for a hook, prefix for a policy, or command for an MCP server.  |
| `--target <target>`    | None         | Overlay target. Required, and must be exactly one, for `kind: overlay`. |
| `--profile <profile>`  | `plugin`     | Overlay output profile: `plugin` or `project`.                          |
| `--force`              | Off          | Replace an existing component.                                          |
| `--dry-run`            | Off          | Report the plan without writing.                                        |
| `--check`              | Off          | Report whether the component is already present and current.            |
| `--format <fmt>`       | `llm`        | Output as `llm`, `human`, or `json`. Shorthands: `-fh`, `-fj`.          |
| `--envelope`           | Off          | Wrap `--format json` output in the versioned result envelope.           |
| `-h`, `--help`         | —            | Show help.                                                              |

`--check` and `--dry-run` cannot be combined.

## What each kind writes

| Kind      | Files                                                                                     |
| --------- | ----------------------------------------------------------------------------------------- |
| `skill`   | `skills/<name>/SKILL.md`                                                                  |
| `agent`   | `agents/<name>.agent.md`                                                                  |
| `rule`    | `rules/<name>.md`                                                                         |
| `hook`    | `hooks/hooks.yaml`, plus `hooks/<event>.sh` (mode `0755`) unless `--command` is given     |
| `policy`  | `policies/<name>.yaml`, with matching positive and negative examples so it parses cleanly |
| `mcp`     | `mcp/mcp.yaml`                                                                            |
| `overlay` | `native/<target>/<profile>/`                                                              |

## Diagnostics

| Code    | Severity | Meaning                                                   |
| ------- | -------- | --------------------------------------------------------- |
| `AB201` | error    | The component already exists and `--force` was not given. |
| `AB202` | error    | The hook name is not a portable event.                    |
| `AB203` | notice   | The manifest edit will normalize incidental whitespace.   |

## Examples

```bash
# Manifest stays byte-identical.
cairn agent add skill prepare-release ./release-helper

# A file-scoped rule.
cairn agent add rule typescript ./release-helper \
  --activation files --glob 'src/**/*.ts'

# A hook, named by its portable event.
cairn agent add hook pre-tool-use ./release-helper

# A non-default root; this one does edit the manifest.
cairn agent add skill other ./release-helper --path lib/skills
```

## Exit codes

| Code | Meaning                                                                              |
| ---- | ------------------------------------------------------------------------------------ |
| `0`  | Component added, or dry run completed.                                               |
| `1`  | Invocation error, or no `agent-bundle.yaml` at the bundle root.                      |
| `2`  | `--check` found a missing or differing component, or a diagnostic blocked the write. |
