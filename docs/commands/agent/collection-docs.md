# `agent collection-docs`

## Synopsis

```text
cairn agent collection-docs [spec] [options]
```

Emits one documentation artifact covering **every installable** agent bundle a repository
publishes. "Installable" is the `plugin` output profile: a self-contained directory with its own
manifest, which a host installs from a marketplace or a plugin directory. The bundle a repository
installs into _itself_ is a different artifact; see [`agent docs`](docs.md).

All of the collection's bundles land in a single document, because they are installed from a
single marketplace: a reader arrives at the collection and chooses between its bundles, so
splitting them into one artifact each would make the choice the one thing not written down.

The spec path defaults to `agent-marketplace.yaml` in the working directory. The payload conforms
to the `installable-agent-bundles` schema, printed by `cairn schema installable-agent-bundles`.

## Options

| Option                | Default             | Description                                                              |
| --------------------- | ------------------- | ------------------------------------------------------------------------ |
| `--profile <profile>` | `plugin`            | `plugin`, `project`, or `both`. The default is what "installable" means. |
| `--out <file>`        | —                   | Also write the standalone documentation artifact here.                   |
| `--id <id>`           | The collection name | The slug the artifact publishes under.                                   |
| `--title <title>`     | The collection name | Human label for navigation.                                              |
| `--strict`            | Off                 | Treat warnings as findings.                                              |
| `--format <fmt>`      | `llm`               | Output as `llm`, `human`, or `json`. Shorthands: `-fh`, `-fj`.           |
| `--envelope`          | Off                 | Wrap `--format json` stdout in the versioned result envelope.            |
| `-h`, `--help`        | —                   | Show help.                                                               |

There is no `--target`: the hosts come from the spec, and each bundle is narrowed further to the
targets its own `include` or `exclude` list names. A bundle the collection excludes from a host is
not documented as reaching it.

## What the payload contains

| Field         | Description                                                                               |
| ------------- | ----------------------------------------------------------------------------------------- |
| `marketplace` | The collection from the spec: name, version, owner, and the hosts it is built for.        |
| `bundles`     | Every bundle the spec names, each in the same shape [`agent docs`](docs.md) emits.        |
| `diagnostics` | Findings against the spec itself, as distinct from those carried on an individual bundle. |

`bundles` is in **spec order**, not sorted. `agent-marketplace.yaml` lists the bundles in the
order a reader should meet them, and that is editorial information the artifact does not discard.

Everything else — bundle-relative paths, omitted component kinds, the render matrix, the pruned
graph — behaves as it does for [`agent docs`](docs.md), including the rule that an approximate
mapping is not a finding.

## Examples

```bash
# Publish the collection.
cairn agent collection-docs --out docs/installable-bundles/artifact.json

# Which bundles, and how big is each one's Claude Code install?
cairn agent collection-docs -fj | jq '
  .collectionDocs.bundles[]
  | { name, files: ([.targets[] | select(.target == "claude-code") | .artifacts | length] | add) }'

# Which bundles are not built for Cursor?
cairn agent collection-docs -fj | jq -r '
  .collectionDocs.bundles[]
  | select([.targets[].target] | index("cursor") | not) | .name'
```

## Exit codes

| Code | Meaning                                               |
| ---- | ----------------------------------------------------- |
| `0`  | Artifact emitted.                                     |
| `1`  | Invocation error.                                     |
| `2`  | Spec or bundle errors, or a warning under `--strict`. |

## See also

- [`agent docs`](docs.md) — the bundle a repository installs into itself.
- [`agent marketplace`](marketplace.md) — building the collection this describes.
- [`agent-marketplace.yaml`](../../formats/agent-marketplace.md) — the spec format.
