# `agent uninstall`

## Synopsis

```text
cairn agent uninstall <name> --target <target> [options]
```

Removes a bundle previously placed by [`agent install`](install.md). It reads
`.cairn-install.json` at the destination and deletes **exactly that inventory** — never
neighboring files the host or another tool may have added.

**Stability: experimental.** The payload shape may change before it hardens.

## Arguments

| Argument | Required | Description            |
| -------- | -------- | ---------------------- |
| `name`   | Yes      | Installed bundle name. |

## Options

| Option              | Default  | Description                                                                                |
| ------------------- | -------- | ------------------------------------------------------------------------------------------ |
| `--target <target>` | Required | One target: `claude-code`, `codex`, `cursor`, or `antigravity`. Not repeatable, not `all`. |
| `--scope <scope>`   | Search   | `user` or `project`. When omitted, both scopes are searched.                               |
| `--into <dir>`      | Profile  | Override the install root the profile declares.                                            |
| `--dry-run`         | Off      | Report the removal without writing.                                                        |
| `--check`           | Off      | Exit 2 when the named install is still present; exit 0 when already absent.                |
| `--format <fmt>`    | `llm`    | Output as `llm`, `human`, or `json`. Shorthands: `-fh`, `-fj`.                             |
| `--envelope`        | Off      | Wrap `--format json` output in the versioned result envelope.                              |
| `-h`, `--help`      | —        | Show help.                                                                                 |

`--check` and `--dry-run` cannot be combined.

`--scope` is optional so a listing from [`agent installed`](installed.md) can be turned
into a removal without restating the scope. Two matches is an error rather than a guess.

A `--link` install removes the host-side symlink and the materialized `.install/` tree the
manifest recorded. A `--register` install also drops the `extraKnownMarketplaces` and
`enabledPlugins` entries it added, and only those, and only when they still point at this
destination.

## Diagnostics

| Code    | Severity | Meaning                                                         |
| ------- | -------- | --------------------------------------------------------------- |
| `AB800` | error    | No recorded install location for this target and scope.         |
| `AB806` | error    | Install manifest missing or malformed, or nothing to uninstall. |

## Examples

```bash
cairn agent uninstall markdown --target cursor --scope user

# Search both scopes; fail if both have a copy.
cairn agent uninstall markdown --target claude-code

# CI: fail while the named install is still present.
cairn agent uninstall markdown --target cursor --scope user --check
```

## Exit codes

| Code | Meaning                                                                      |
| ---- | ---------------------------------------------------------------------------- |
| `0`  | Removed, already absent under `--check`, or dry run completed.               |
| `1`  | Invocation or I/O error.                                                     |
| `2`  | Manifest missing or malformed, or `--check` found the install still present. |
