# Inline agent bundle artifact

What [`agent docs`](../commands/agent/docs.md) emits: a documentation artifact describing the
agent bundle a repository installs into itself.

**Inline** is the `project` output profile — the bundle's files merged into the repository's own
dot-directories (`.claude/skills/…`, `.cursor/rules/…`), with no manifest of their own. A
repository has at most one, which is why this artifact carries a single bundle where
[its installable sibling](installable-agent-bundles.md) carries a list.

The schema is published as `@cairn-tool/agent-bundle-schema` and printed by
`cairn schema inline-agent-bundle`. The normative specification is [`spec/README.md`](../../spec/README.md).

## The file

`--out` writes the standalone artifact: cairn's versioned result envelope with the payload as its
`data`.

```json
{
  "schemaVersion": "4",
  "tool": { "name": "@cairn-tool/cairn", "version": "6.1.0" },
  "command": "agent docs",
  "ok": true,
  "exitCode": 0,
  "schema": "https://github.com/cairn-tool/cairn/schema/v1/inline-agent-bundle.json",
  "data": {
    "kind": "inline-agent-bundle",
    "schemaVersion": "1.0.0",
    "id": "cairn-markdown",
    "title": "Cairn Markdown",
    "generatedAt": "2026-09-19T15:21:37.782Z",
    "generator": { "name": "@cairn-tool/cairn", "version": "6.1.0" },
    "bundle": { "...": "..." }
  }
}
```

`schema` names the document `data` conforms to. The command's **stdout** is a different thing — an
[agent result](diagnostics.md) carrying the same payload under `docs` — on the same split
[`agent convert`](../commands/agent/convert.md) makes when it writes `conversion-report.json`.

## Payload

| Field           | Required | Notes                                                                                                          |
| --------------- | -------- | -------------------------------------------------------------------------------------------------------------- |
| `kind`          | yes      | `inline-agent-bundle`. A constant.                                                                             |
| `schemaVersion` | yes      | Semantic version of the payload format. A consumer accepts a higher patch or minor and rejects a higher major. |
| `id`            | yes      | The slug the artifact publishes under. Defaults to the bundle name.                                            |
| `title`         | yes      | Human label. Defaults to `marketplace.displayName`, then the bundle name.                                      |
| `generatedAt`   | yes      | RFC 3339, UTC.                                                                                                 |
| `generator`     | yes      | `{ name, version }` of the tool that produced it.                                                              |
| `bundle`        | yes      | The documented bundle.                                                                                         |

### `bundle`

| Field                            | Required | Notes                                                                              |
| -------------------------------- | -------- | ---------------------------------------------------------------------------------- |
| `name`, `version`, `description` | yes      | As the manifest spells them.                                                       |
| `manifestSchemaVersion`          | yes      | The source `agent-bundle.yaml`'s own version. Unrelated to the payload's.          |
| `legacy`                         | yes      | True when the source is a native plugin read through `.claude-plugin/plugin.json`. |
| `source`                         | no       | Path to the bundle root, relative to the repository or collection root.            |
| `marketplace`                    | no       | The manifest's listing block. Absent means the bundle declares none.               |
| `components`                     | yes      | Everything the bundle carries, by kind.                                            |
| `graph`                          | yes      | Which components reference which skills.                                           |
| `dependencies`                   | yes      | Declared dependency bundles and the component names they define.                   |
| `targets`                        | yes      | The render matrix.                                                                 |
| `diagnostics`                    | yes      | Findings from parsing and rendering.                                               |

### Components

Each skill, subagent and rule carries `name`, `description`, `source`, `metadata` and **`body`** —
the Markdown beneath the frontmatter, verbatim and unrendered. The body is the difference between
this artifact and [`agent inspect`](../commands/agent/inspect.md): a documentation site renders
the component from the artifact without reading the bundle.

A rule additionally carries `activation` and `globs`.

A component kind that no selected target emits into a selected profile is **omitted**, not shown
empty. Hooks are plugin-profile only on every target, so an inline artifact has no `hooks` — the
absence is accurate, not a gap.

### The render matrix

```json
"targets": [
  { "target": "claude-code", "profile": "project",
    "artifacts": [{ "path": ".claude/skills/md-lint/SKILL.md", "bytes": 2317, "mode": "0644" }] }
]
```

One entry per host and profile the bundle renders into, produced by the renderer itself rather
than reconstructed from the [target profiles](target-profile.md) — so the artifact cannot claim a
layout `agent convert` would not write. Content is excluded: this documents the shape of an
installation, not a copy of one. A host and profile that render nothing are left out rather than
listed empty.

`origin: "native"` marks a file contributed by a target-native overlay. Its absence means portable.

## Reproducibility

Two runs over the same bundle produce the same bytes apart from `generatedAt`. Every array is
sorted by byte order rather than locale order, and every path is bundle-relative and
POSIX-separated rather than the absolute path the parser resolved — a consumer fingerprints these
documents, and an absolute path would change the fingerprint on every machine that rebuilt it.

A component's `files` are rebased to the bundle root as well, so every path in the document is
relative to one thing.

## Diagnostics

Findings carry the `AB###` codes documented in [Diagnostic codes](diagnostic-codes.md).

An `approximate` mapping is **not** a finding here. Recording that a component reaches a host in a
changed form is what the artifact is for, and every Codex bundle carries one; the rest of the
`agent` toolset's rule would make documenting a bundle an error. Only an error severity, or a
warning under `--strict`, exits 2.

## See also

- [Installable agent bundles artifact](installable-agent-bundles.md)
- [Agent bundle format and syntax](agent-bundle.md) — the source this describes.
- [Target profile](target-profile.md) — where `profile` and install `layout` are declared.
