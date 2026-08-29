# `schema`

## Synopsis

```text
cairn schema [id] [options]
```

Prints a published output schema, or lists the schemas available. Together with
[`describe`](describe.md) this makes the CLI's JSON output a documented API rather than
something to reverse-engineer.

See [the result contract](../contract.md) for the versioning and compatibility rules.

## Arguments

| Argument | Required | Description                                                            |
| -------- | -------- | ---------------------------------------------------------------------- |
| `id`     | No       | Schema id, for example `agent-result`. Omit to list what is available. |

## Options

| Option           | Default | Description                                                    |
| ---------------- | ------- | -------------------------------------------------------------- |
| `--format <fmt>` | `llm`   | Output as `llm`, `human`, or `json`. Affects the listing only. |
| `-h`, `--help`   | —       | Show help.                                                     |

With an `id`, the schema document is written as-is regardless of `--format` — a schema is
already JSON.

## Schema ids are identifiers

Schema `$id` values look like URLs:

```text
https://github.com/bstockus/cairn/schema/v1/md-graph.json
```

They are identifiers, not fetchable URLs. `cairn schema <id>` is how you retrieve one.
Every schema is self-contained — no `$ref` leaves its own document — so what you retrieve can
be compiled on its own by any JSON Schema 2020-12 validator.

No published schema sets `additionalProperties: false`. Consumers must ignore unknown
properties, since adding one is a non-breaking change.

## Examples

```bash
# What is published?
cairn schema

# Retrieve one.
cairn schema agent-result

# Save a schema for CI validation.
cairn schema md-audit > md-audit.schema.json

# Which commands does a schema cover?
cairn schema --format json | jq '.schemas[] | select(.id == "issue-list") | .commands'
```

## Exit codes

| Code | Meaning                               |
| ---- | ------------------------------------- |
| `0`  | Schema or listing written to stdout.  |
| `1`  | Unknown schema id, or invalid format. |
