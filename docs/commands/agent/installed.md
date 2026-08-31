# `agent installed`

## Synopsis

```text
cairn agent installed [options]
```

Lists bundles this CLI has installed, by scanning the roots declared on the target profiles
for `.cairn-install.json`. It reports observed state and never writes.

One destination may record several installs, so one directory can produce several rows. Rows
are sorted by target, scope, name, profile, and destination.

**Stability: experimental.** The payload shape may change before it hardens.

## Options

| Option              | Default | Description                                                                               |
| ------------------- | ------- | ----------------------------------------------------------------------------------------- |
| `--target <target>` | all     | Repeatable target: `claude-code`, `codex`, `cursor`, `antigravity`, `opencode`, or `all`. |
| `--scope <scope>`   | both    | `user` or `project`.                                                                      |
| `--into <dir>`      | Profile | Override the install root the profile declares.                                           |
| `--format <fmt>`    | `llm`   | Output as `llm`, `human`, or `json`. Shorthands: `-fh`, `-fj`.                            |
| `--envelope`        | Off     | Wrap `--format json` output in the versioned result envelope.                             |
| `-h`, `--help`      | —       | Show help.                                                                                |

Malformed manifests are skipped rather than reported: [`agent uninstall`](uninstall.md)
is the command that refuses to guess (`AB806`).

## Examples

```bash
cairn agent installed
cairn agent installed --target cursor --scope user
cairn agent installed --into ./plugins -fj | jq '.install.installs'
```

## Exit codes

| Code | Meaning                    |
| ---- | -------------------------- |
| `0`  | Listing written to stdout. |
| `1`  | Invocation error.          |
