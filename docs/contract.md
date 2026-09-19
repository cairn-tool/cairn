# Machine-readable result contract

`cairn` is meant to be run by agents and CI, not only by people. This document is the
contract those consumers can rely on: what each command emits, which stream it lands on, what
the exit code means, and how all of that is allowed to change.

Two commands make the contract self-describing, so nothing here needs to be scraped from
`--help`:

```bash
cairn describe --format json          # every command, option, exit code, and schema id
cairn describe md graph --format json # one command
cairn schema                          # the published schemas
cairn schema md-graph                 # one schema document
```

## Contract version

`schemaVersion` (currently `4`) versions the **contract surface**: the envelope shape, the
schema id scheme, and the machine-stream guarantees below. It is hand-owned and unrelated to
the package version, which semantic-release manages. It is reported by the `--envelope` wrapper
and by `schema --format json`.

The `describe` payload is the one shape it does not version. That document conforms to the
[cli-schema specification](https://github.com/cairn-tool/cli-schema), a portable description
of a command-line interface that this tool's own walker was extracted into, and its
`schemaVersion` field is that specification's (currently `1`), owned there. Cairn's contract
version records when the payload _consumed_ from `describe` changes — see the 3 → 4 entry in
the [history](#contract-history) — but the field itself is the spec's.

Individual payloads are versioned separately, by the major in their schema id path. A breaking
change to one command's output publishes `v2/<id>.json` and changes that command's
`outputSchema`; it does not bump `schemaVersion`.

### The other hand-owned versions

Seven versions in this project are owned by hand rather than by semantic-release, and none of
them is the package version. They version different things and move independently:

| Version                          | Versions                                               | Reported by                                    |
| -------------------------------- | ------------------------------------------------------ | ---------------------------------------------- |
| Contract `schemaVersion`         | The contract surface described here                    | `--envelope`, `schema --format json`           |
| Target profile `schemaVersion`   | The structure of a target conformance profile          | `agent specs`                                  |
| Bundle `schemaVersion`           | The `agent-bundle.yaml` format authors write           | `agent inspect`                                |
| Test file `schemaVersion`        | The assertion format `agent test` cases are written in | `agent test` (`test.schemaVersion`)            |
| Marketplace spec `schemaVersion` | The `agent-marketplace.yaml` format authors write      | `agent marketplace`                            |
| Release manifest `schemaVersion` | The `release-manifest.json` a release branch carries   | `agent marketplace --layout release`           |
| Usage store version              | The SQLite schema of `usage.db`                        | `usage index`, `usage migrate`, `usage import` |
| Artifact payload `schemaVersion` | The documentation artifact payload format              | `agent docs`, `agent collection-docs`          |

A ninth version appears in output but is not this project's to bump: the cli-schema
`schemaVersion` that `describe` carries.

A normal release bumps none of them.

#### The usage store version is migrated, not discarded

It is the odd one out, and the difference matters. The other private stores in this project —
the URL cache, the workspace index — invalidate by _discarding_: a version mismatch throws the
file away, costs a re-parse, and can never produce a wrong answer. Their versions are private,
undocumented, and safe to bump at will.

The usage store cannot work that way. Once `archive run --include transcripts` has run and the
source logs have been pruned, the store may be the only surviving record of that usage, so a
version bump has to carry the data forward. It is stored in `PRAGMA user_version` and the
migration list is `src/usage/db/migrations.ts`. Three rules follow:

- a shipped migration is never edited, because a store in the field has already run it; add a
  new one instead
- a migration has to work on real data, not only on an empty file
- a store whose version exceeds what the running build understands is **refused**, not opened —
  it may carry columns this build would drop on its next write

It is still not part of the payload contract: it versions a file on disk, not a payload shape.
It is listed here because it is hand-owned, and because a consumer reading `schemaVersion` out
of `usage index` needs to know which of the two kinds of version it is looking at.

## Schema ids

Schema ids look like URLs:

```text
https://github.com/cairn-tool/cairn/schema/v1/md-graph.json
```

They are **identifiers, not fetchable URLs**. Retrieve a schema with `cairn schema <id>`.
Every schema is self-contained — no `$ref` leaves its own document — so a retrieved schema can
be compiled on its own.

One published id is not under that path. `describe` is the cli-schema document, so its `$id` is
`https://github.com/cairn-tool/cli-schema/v1/cli-schema.json`, owned by that project and
re-served here verbatim; `cairn schema describe` still retrieves it.

**No published schema sets `additionalProperties: false`, and consumers must ignore properties
they do not recognize.** Adding a property is a non-breaking change; a consumer that rejects
unknown properties would break on every such change.

## What is and is not a breaking change

| Non-breaking (minor or patch)                | Breaking (major)                              |
| -------------------------------------------- | --------------------------------------------- |
| Adding a property to a payload               | Removing or renaming a property               |
| Adding a command, option, or accepted format | Changing a property's type or meaning         |
| Publishing a schema where the id was `null`  | Moving a payload between stdout and stderr    |
| Relaxing a constraint                        | Changing which exit code a condition produces |
|                                              | Removing a command, option, or format         |

## Exit codes

| Code | Meaning                                  |
| ---- | ---------------------------------------- |
| `0`  | Success; no actionable findings.         |
| `1`  | Invocation, I/O, or configuration error. |
| `2`  | Actionable findings.                     |

Per-command meanings are in `describe` output under `exitCodes`.

One command deviates, and says so in its own field rather than in prose. `scripts run` executes
a child process, and in `llm` and `human` formats it forwards that child's exit status
verbatim — any value from `0` to `255`, including `128 + signal` for a child killed by a
signal — because a hook that reads `$?` needs the real code. `describe` reports that range
under `exitCodePassthrough`, which is present only on commands that forward a status. The
`exitCodes` array continues to describe the codes this tool decides itself: `1` for an
unresolvable name or a script that never started, and under `--format json`, `0` and `2` for a
script that ran.

That command's `--ignore-exit-code` turns the passthrough off and exits `0` for every outcome,
which is a deliberate exception to both tables rather than a third convention: it exists so an
invocation inline in a skill document cannot keep the skill from loading. Nothing in the payload
changes with it — `exit.status` still carries the script's real code.

## Streams

The general rule is **actionable findings to stderr, clean and informational output to
stdout**. `describe` reports the actual assignment per command under `stream`, because a few
commands deviate. Those deviations are recorded rather than fixed, since changing them would be
breaking:

- `md links --format json` writes to stdout and returns before the broken-link check, so it
  exits `0` even when broken links exist.
- `md graph --output mermaid|dot` writes the diagram to stdout regardless of exit status and
  ignores `--format`.
- Every `agent` subcommand writes to stdout, including the failure result for an invocation
  error.
- `md lint-dir --summary --format json` emits a per-file summary, a different shape from the
  finding list `md lint-dir` emits without `--summary`.
- `md section --raw` and `md frontmatter --key` bypass the JSON shape: the first writes
  markdown, the second writes the raw extracted value, which may be a scalar or `null`.

## The update notice never corrupts a parse

The advisory update notice is written to **stderr only**, and only when every one of these
holds:

- `CAIRN_NO_UPDATE_NOTIFIER` is not `1`
- `CI` is unset
- stderr is a TTY
- `--format` is not `json`, `jsonl`, or `sarif`, including a format selected by project
  configuration
- the command is not `check-update`, `describe`, `schema`, `completion`, or the internal cache
  refresh

The same gate also blocks the background refresh, so a non-interactive caller never spawns a
child process. `describe` reports these conditions under `advisoryOutput`, read directly from
the code that enforces them.

## The result envelope

By default every command emits its own payload shape, unchanged from previous releases. Pass
`--envelope` alongside `--format json` for a uniform wrapper:

```bash
cairn md graph docs --format json --envelope
```

```json
{
  "schemaVersion": "4",
  "tool": { "name": "@cairn-tool/cairn", "version": "6.0.0" },
  "command": "md graph",
  "ok": false,
  "exitCode": 2,
  "schema": "https://github.com/cairn-tool/cairn/schema/v1/md-graph.json",
  "data": {},
  "summary": { "broken": 2, "unreachable": 1 }
}
```

`data` holds the command's payload **verbatim**, so unwrapping it yields exactly the output of
the same run without the flag. `schema` is `null` for commands whose payload has no published
schema yet. `--envelope` without `--format json` is an error rather than a silent no-op, and
`describe` and `schema` do not accept it — a schema document is written as-is, and the contract
description is not a command result.

## Experimental commands

Most commands are `stability: "stable"` and are covered by the breaking-change rules above. The
agent lifecycle commands added most recently, and every `jira adf` subcommand, are declared
`stability: "experimental"` in `describe` output, meaning their payload shapes may still change
without a major schema version:

```bash
cairn describe -fj | jq -r '.commands[] | select(.stability=="experimental") | .id'
```

The agent ones share the `agent-result` schema with the stable agent commands; the `jira adf`
subcommands, also experimental, publish `adf-result`, every `pdf` subcommand publishes
`pdf-result`, and every `qa` subcommand publishes `qa-result`. The stable commands' guarantees
are unaffected.

## Published schemas

| Id                          | Covers                                                                          |
| --------------------------- | ------------------------------------------------------------------------------- |
| `issue`                     | A single finding record.                                                        |
| `issue-list`                | `md lint`, `md lint-dir`, `md validate-frontmatter`, `md refs`, `md links`      |
| `diagnostic-record`         | One line of `--format jsonl` output.                                            |
| `lint-dir-summary`          | `md lint-dir --summary --format json`                                           |
| `md-graph`                  | `md graph --output report`                                                      |
| `md-audit`                  | `md audit`                                                                      |
| `md-query`                  | `md query`                                                                      |
| `md-check-urls`             | `md check-urls`                                                                 |
| `md-orphans`                | `md orphans`                                                                    |
| `md-index`                  | `md index`                                                                      |
| `md-context`                | `md context`                                                                    |
| `md-diff`                   | `md diff`                                                                       |
| `md-fix`                    | `md fix`                                                                        |
| `agent-result`              | Every `agent` subcommand, including the failure form.                           |
| `adf-result`                | Every `jira adf` subcommand, including the failure form.                        |
| `pdf-result`                | Every `pdf` subcommand, including the failure form.                             |
| `qa-result`                 | Every `qa` subcommand.                                                          |
| `check-update`              | `check-update`                                                                  |
| `describe`                  | `describe --format json` — the cli-schema v1 document, owned by that project    |
| `schema-list`               | `schema --format json` with no id                                               |
| `envelope`                  | The `--envelope` wrapper                                                        |
| `inline-agent-bundle`       | `agent docs` — the artifact payload, owned by `@cairn-tool/agent-bundle-schema` |
| `installable-agent-bundles` | `agent collection-docs` — the artifact payload, same owner                      |

SARIF output follows the external
[SARIF 2.1.0 schema](https://json.schemastore.org/sarif-2.1.0.json); it is referenced, not
redefined.

Commands not listed report `"outputSchema": null` in `describe`. That is an honest statement
that no schema is published yet, not that the command has no JSON output. Publishing one later
is explicitly non-breaking.

## Consuming the contract

```bash
# Discover commands instead of parsing --help.
cairn describe --format json | jq '.commands[] | select(.writes) | .id'

# Find which stream a command puts findings on.
cairn describe md audit -fj | jq '.commands[0].stream'

# Validate CI output against the declared schema.
cairn schema md-audit > md-audit.schema.json
cairn md audit docs --format json > audit.json || true
# ...then validate audit.json with any JSON Schema 2020-12 validator.
```

`describe` reports the **static** contract. Project configuration from `.cairn.yml` is not
applied, so `defaultFormat` is the built-in default rather than the resolved one and the answer
does not depend on the working directory.

## Contract history

`schemaVersion` has moved three times. The first two were because a _published value_ changed
rather than a payload _shape_; the third changed the shape of `describe`. In every bump the
`v1` segment of every schema id this project authors is unchanged — those payloads are
identical — and the short ids `cairn schema <id>` takes are unchanged.

### 3 → 4: `describe` conforms to cli-schema v1

The private walker behind `describe` became the
[cli-schema](https://github.com/cairn-tool/cli-schema) project, and `describe` now emits that
specification's document. Everything at the command level — `id`, `path`, `formats`,
`exitCodes`, `exitCodePassthrough`, `stream`, `writes`, `stability`, `notes` — is unchanged.
What moved:

- `schemaVersion` on the `describe` payload is the spec's `"1"`, not this contract's `"4"`.
- `machineStreams` is now `advisoryOutput`, with the same four fields.
- Each option's `{flags, long, short, valueRequired, valueOptional, mandatory, variadic,
negated, repeatable}` became `{name, aliases, arity, required, negatable, valueType,
allowedValues, recursive}`: `long` → `name`, `short` → `aliases[0]`, `mandatory` →
  `required`, `negated` → `negatable`, `repeatable` ⇔ `arity.max === null`, `valueRequired`
  ⇔ `valueName` set and `arity.min ≥ 1`, `valueOptional` ⇔ `valueName` set and
  `arity.min === 0`.
- Each argument's `{required, variadic}` became `arity`: `required` ⇔ `arity.min ≥ 1`,
  `variadic` ⇔ `arity.max === null`.
- `jsonlSchema` and `sarifSchema` are omitted rather than `null` when a command has none.
- `usage` is derived by the spec's rule rather than taken from commander.
- The `describe` schema's `$id` moved from `…/cairn/schema/v1/describe.json` to
  `https://github.com/cairn-tool/cli-schema/v1/cli-schema.json`.

### 2 → 3: the move to the `cairn-tool` organisation

- Schema `$id`s moved from `https://github.com/bstockus/cairn/schema/v1/<id>.json` to
  `https://github.com/cairn-tool/cairn/schema/v1/<id>.json`.
- `tool.name` in the envelope and in `describe`, and `generator.name` in every report Cairn
  writes, is now `@cairn-tool/cairn`. The package is published to the public npm registry;
  `@bstockus/cairn` on GitHub Packages is not updated past v1.11.0.

### 1 → 2: the rename from claude-cli

- Schema `$id`s moved from `https://github.com/bstockus/claude-cli/schema/v1/<id>.json` to
  `https://github.com/bstockus/cairn/schema/v1/<id>.json`.
- `machineStreams.optOutEnv` is now `CAIRN_NO_UPDATE_NOTIFIER`. The pre-rename variable is
  still honored, but only the current one is published here.
- `tool.name` became `@bstockus/cairn`.

Identifiers Cairn writes into a workspace — `.cairn.yml`, the TOC markers, the
`cairn:snippet=` attribute, `.cairn-install.json`, and the two baseline discriminators —
are all still _read_ under their pre-rename spellings, so no committed file needs editing.
[The migration guide](migration.md) lists each pair.
