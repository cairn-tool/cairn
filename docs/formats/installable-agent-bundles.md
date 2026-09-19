# Installable agent bundles artifact

What [`agent collection-docs`](../commands/agent/collection-docs.md) emits: one documentation
artifact covering every agent bundle a repository publishes for other people to install.

**Installable** is the `plugin` output profile — a self-contained directory with its own manifest,
which a host discovers through a marketplace or a plugin directory rather than by merging files
into a project. The bundle a repository installs into _itself_ is
[a different artifact](inline-agent-bundle.md).

All of a repository's bundles land in **one** document. They are installed from one marketplace: a
reader arrives at the collection and chooses between its bundles, so splitting them into one
artifact each would make the choice the one thing not written down.

The schema is published as `@cairn-tool/agent-bundle-schema` and printed by
`cairn schema installable-agent-bundles`. The normative specification is
[`spec/README.md`](../../spec/README.md).

## Payload

| Field           | Required | Notes                                                                   |
| --------------- | -------- | ----------------------------------------------------------------------- |
| `kind`          | yes      | `installable-agent-bundles`. A constant.                                |
| `schemaVersion` | yes      | Semantic version of the payload format.                                 |
| `id`            | yes      | The slug the artifact publishes under. Defaults to the collection name. |
| `title`         | yes      | Human label. Defaults to the collection name.                           |
| `generatedAt`   | yes      | RFC 3339, UTC.                                                          |
| `generator`     | yes      | `{ name, version }` of the tool that produced it.                       |
| `marketplace`   | yes      | The collection itself.                                                  |
| `bundles`       | yes      | Every bundle the spec names.                                            |
| `diagnostics`   | no       | Findings against the spec itself.                                       |

### `marketplace`

Read from [`agent-marketplace.yaml`](agent-marketplace.md).

| Field         | Required | Notes                                                                          |
| ------------- | -------- | ------------------------------------------------------------------------------ |
| `name`        | yes      | Also the marketplace key a host registers the collection under.                |
| `version`     | yes      |                                                                                |
| `description` | no       |                                                                                |
| `owner`       | yes      | `{ name, url?, email? }`.                                                      |
| `targets`     | yes      | Hosts the collection is built for. A bundle may narrow this with its own list. |

### `bundles`

Each entry has the same shape as the `bundle` field of the
[inline artifact](inline-agent-bundle.md#bundle), including `source` — the bundle's path as the
spec writes it.

`bundles` is in **spec order**, not sorted. `agent-marketplace.yaml` lists the bundles in the
order a reader should meet them, and that is editorial information the artifact does not discard.

Each bundle is narrowed to the targets its own spec entry `include`s or does not `exclude`, so a
bundle the collection excludes from a host is not documented as reaching it. There is no
`--target` on the command for that reason: the hosts come from the spec.

### `diagnostics`

Findings raised against the collection spec — the `AB9xx` family — as distinct from those carried
on an individual bundle, which stay beside the bundle they belong to.

## Everything else

Bundle-relative paths, omitted component kinds, the render matrix, the pruned graph, and the rule
that an approximate mapping is not a finding all behave exactly as they do for the
[inline artifact](inline-agent-bundle.md). The two kinds share their definitions; the schemas
publish an inlined copy each so either can be validated on its own.

## See also

- [Inline agent bundle artifact](inline-agent-bundle.md)
- [Marketplace spec](agent-marketplace.md) — the source this reads.
- [`agent marketplace`](../commands/agent/marketplace.md) — building the collection this describes.
