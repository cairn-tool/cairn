# `agent upgrade`

## Synopsis

```text
cairn agent upgrade <source> --to-schema <version> [options]
```

Migrates a portable bundle between neutral schema versions. Only `agent-bundle.yaml` is
rewritten — no component file is touched — because
[schema 2](convert.md#native-overlays) is a strict superset of schema 1 and adds only
what schema 1 could not express.

**Stability: experimental.** The payload shape may change before it hardens.

## Arguments

| Argument | Required | Description                                 |
| -------- | -------- | ------------------------------------------- |
| `source` | Yes      | Bundle root containing `agent-bundle.yaml`. |

## Options

| Option                  | Default  | Description                                                    |
| ----------------------- | -------- | -------------------------------------------------------------- |
| `--to-schema <version>` | Required | Target bundle schema version. Currently only `2`.              |
| `--dry-run`             | Off      | Report the migration without writing.                          |
| `--check`               | Off      | Exit `2` when the bundle is not already at the target schema.  |
| `--format <fmt>`        | `llm`    | Output as `llm`, `human`, or `json`. Shorthands: `-fh`, `-fj`. |
| `--envelope`            | Off      | Wrap `--format json` output in the versioned result envelope.  |
| `-h`, `--help`          | —        | Show help.                                                     |

`--check` and `--dry-run` cannot be combined.

**`--to-schema` is required rather than defaulting to the newest version.** An implicit
"latest" would make a CI run's result depend on which `cairn` happened to be installed.

## What the 1 → 2 migration does

| Change          | Detail                                                                                                                      |
| --------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `schemaVersion` | `'1'` → `'2'`.                                                                                                              |
| Component paths | Top-level keys such as `skills:` move under `components:`. Both spellings still parse; the nested one is the v2 convention. |
| Comments        | Preserved. The manifest is edited through a YAML document, not re-serialized from parsed data.                              |
| `marketplace:`  | **Not synthesized.** See below.                                                                                             |
| `native:`       | Not created. Overlay roots default to `native/<target>` when the directory exists.                                          |

### Marketplace metadata is deliberately not invented

A half-filled `marketplace:` block would look like a decision nobody made, and
`agent package` would then report findings against values this migration guessed. Instead the
command emits an `AB221` notice and a `upgrade.notes` entry telling you to add the block
yourself.

## The byte-identity guard

Because schema 2 adds nothing that changes rendering, a migration that alters any generated
byte is a defect. The command proves this rather than assuming it: before writing, it renders
the bundle with the current manifest and again with the migrated one, in memory, across every
target and both profiles. If the two differ it emits `AB224` and refuses to write.

## Diagnostics

| Code    | Severity | Meaning                                                                                  |
| ------- | -------- | ---------------------------------------------------------------------------------------- |
| `AB220` | notice   | The bundle is already at the requested schema; nothing was written.                      |
| `AB221` | notice   | Marketplace metadata cannot be derived and needs human judgment.                         |
| `AB222` | error    | The requested target schema is not supported.                                            |
| `AB223` | error    | A legacy Claude plugin has no neutral manifest to upgrade.                               |
| `AB224` | error    | The migration would change generated output. This is a `cairn` defect; please report it. |

An `AB221` notice does **not** fail the command. Only errors, and a stale `--check`, do.

## Examples

```bash
# Would this bundle change? Exits 2 if so. Suitable for CI.
cairn agent upgrade ./release-helper --to-schema 2 --check

# See the change list and the human-judgment notes first.
cairn agent upgrade ./release-helper --to-schema 2 --dry-run -fj | jq '.upgrade'

# Migrate.
cairn agent upgrade ./release-helper --to-schema 2
```

## Exit codes

| Code | Meaning                                                                  |
| ---- | ------------------------------------------------------------------------ |
| `0`  | Migrated, already current, or dry run completed.                         |
| `1`  | Invocation or I/O error, including a missing `--to-schema`.              |
| `2`  | `--check` found a bundle below the target schema, or a blocking finding. |
