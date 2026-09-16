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

`--format json` emits a [cli-schema](https://github.com/cairn-tool/cli-schema) v1 document,
published here as the [`describe`](../contract.md#published-schemas) schema, containing:

| Field              | Description                                                                |
| ------------------ | -------------------------------------------------------------------------- |
| `schemaVersion`    | Version of the cli-schema payload (`1`), owned by that specification.      |
| `tool`             | Package name and version.                                                  |
| `formatShorthands` | The argv tokens expanded before parsing.                                   |
| `advisoryOutput`   | When the update notice is suppressed, read from the code that enforces it. |
| `schemas`          | Published schema ids, titles, and the commands they cover.                 |
| `commands`         | Every visible command.                                                     |

Hidden internal commands are excluded. `cairn schema describe` returns the document the payload
validates against.

### Options and arguments

Each command's `options` carry `name` (the long form), `aliases` (the short form, when one
exists), `description`, `valueName`, `arity`, `required`, `negatable`, `valueType`,
`allowedValues`, `recursive`, and `default` when one is declared. Each of its `arguments`
carries `name`, `description`, `arity`, `valueType`, `allowedValues`, and `default`.

`arity` is `{ min, max }` with `max: null` for unbounded. A flag is `{0, 0}`; an option that
requires a value is `{1, 1}`; one whose value is optional is `{0, 1}`; a repeatable option or
variadic argument has `max: null`. An argument is required when `min ≥ 1`.

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
