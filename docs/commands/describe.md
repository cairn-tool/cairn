# `describe`

## Synopsis

```text
cairn describe [command...] [options]
```

Describes the CLI contract: every command with its arguments, options, accepted formats, exit
code meanings, output stream, and output schema id. This is how an agent discovers the CLI
without scraping `--help`.

The mechanical facts — commands, arguments, options — are read from the command tree itself, so
they cannot drift. The semantic ones — exit code meanings, stream assignment, schema ids,
whether a command writes files — come from a declared contract table, and the test suite fails
if either side gains an entry the other lacks.

See [the result contract](../contract.md) for the compatibility rules this output describes.

## Arguments

| Argument  | Required | Description                                                                  |
| --------- | -------- | ---------------------------------------------------------------------------- |
| `command` | No       | Command path to narrow to, for example `md graph`. Includes its subcommands. |

## Options

| Option           | Default | Description                                                    |
| ---------------- | ------- | -------------------------------------------------------------- |
| `--format <fmt>` | `llm`   | Output as `llm`, `human`, or `json`. Shorthands: `-fh`, `-fj`. |
| `-h`, `--help`   | —       | Show help.                                                     |

An unsupported `--format` is an error rather than a silent fallback: a contract command must
not misreport its own format.

## Output

`--format json` emits the [`describe`](../contract.md#published-schemas) schema, containing:

| Field              | Description                                                                |
| ------------------ | -------------------------------------------------------------------------- |
| `schemaVersion`    | Version of the contract surface.                                           |
| `tool`             | Package name and version.                                                  |
| `formatShorthands` | The argv tokens expanded before parsing.                                   |
| `machineStreams`   | When the update notice is suppressed, read from the code that enforces it. |
| `schemas`          | Published schema ids, titles, and the commands they cover.                 |
| `commands`         | Every visible command.                                                     |

Hidden internal commands are excluded.

## Static, not resolved

`describe` reports the **static** contract. Project configuration from `.cairn.yml` is not
applied, so `defaultFormat` is the built-in default rather than the format that would be used
in a given directory. This keeps the answer independent of the working directory.

## Examples

```bash
# The full contract.
cairn describe --format json

# One command.
cairn describe md graph --format json

# Which commands can modify files?
cairn describe -fj | jq -r '.commands[] | select(.writes) | .id'

# Which commands publish a JSON schema?
cairn describe -fj | jq -r '.commands[] | select(.outputSchema) | "\(.id) -> \(.outputSchema)"'
```

## Exit codes

| Code | Meaning                                  |
| ---- | ---------------------------------------- |
| `0`  | Description written to stdout.           |
| `1`  | Unknown command path, or invalid format. |
