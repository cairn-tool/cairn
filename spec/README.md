# Agent bundle documentation artifacts

This document is normative. It specifies two JSON payloads `cairn` emits to describe the agent
bundles a repository carries, and it is the authority when it and an implementation disagree.

The schemas are published as [`@cairn-tool/agent-bundle-schema`](../packages/agent-bundle-schema),
so a consumer validates an artifact without depending on the CLI.

## The two kinds

A repository carries agent bundles in two distinct capacities, and they are separate artifact
kinds because they answer separate questions.

| Kind                        | Source                   | Command                       | Answers                                             |
| --------------------------- | ------------------------ | ----------------------------- | --------------------------------------------------- |
| `inline-agent-bundle`       | one bundle root          | `cairn agent docs`            | what this repository gives the agents working in it |
| `installable-agent-bundles` | `agent-marketplace.yaml` | `cairn agent collection-docs` | what this repository offers other people            |

**Inline** is the `project` output profile: the bundle's files merged into the repository's own
dot-directories — `.claude/skills/…`, `.cursor/rules/…` — with no manifest of their own. A
repository has at most one, so the artifact carries a single bundle.

**Installable** is the `plugin` output profile: a self-contained directory with its own manifest,
which a host discovers through a marketplace or a plugin directory. Every bundle a repository
publishes lands in **one** artifact, because they are installed from one marketplace and a reader
arrives at the collection and chooses between them. Splitting them would make the choice the one
thing not written down.

Those two words map onto declared data in the target profiles, not onto a special case: `profile`,
and the `layout` of an install location (`merge` for inline; `marketplace` or `plugin-dir` for
installable). See `docs/formats/target-profile.md`.

## Rules

**`$id` is an identifier, not a fetchable URL.** Retrieve a document with `cairn schema <id>` or
from the npm package. Ajv resolves by registered `$id` and never performs network access.

**No schema sets `additionalProperties: false`.** Adding a property is a non-breaking change, and
a consumer must ignore properties it does not recognize. Adding a `$defs` entry is additive.
Adding a `required` entry is not, and must be recorded in a named section of this document.

**Every payload is reproducible.** Two runs over the same bundle, on any machine, under any
locale, must produce the same bytes apart from `generatedAt`. That is why every array is sorted by
byte order rather than locale order, and why every path is bundle-relative POSIX rather than the
absolute path the parser resolved. A consumer fingerprints these documents; an absolute path would
change the fingerprint on every machine that rebuilt it.

**`generatedAt` is RFC 3339, UTC**, and required on every artifact. A consumer normalizes it
before comparing two builds.

**The shared definitions are authored once and published inlined.** `spec/v1/_common.json` is a
build input, not a published document: `npm run codegen` inlines the definitions each artifact
reaches into that artifact's schema, so every published file stands alone. Validating an artifact
requires exactly one document.

## Envelope

The standalone artifact file — what `--out` writes — is cairn's versioned result envelope with the
payload as its `data`:

```json
{
  "schemaVersion": "4",
  "tool": { "name": "@cairn-tool/cairn", "version": "6.1.0" },
  "command": "agent docs",
  "ok": true,
  "exitCode": 0,
  "schema": "https://github.com/cairn-tool/cairn/schema/v1/inline-agent-bundle.json",
  "data": { "kind": "inline-agent-bundle", "...": "..." }
}
```

`schema` names the document `data` conforms to. The command's **stdout** is something else — an
`agent-result`, like every other agent subcommand, carrying the same payload under `docs` or
`collectionDocs`. A pipeline reads the file; a caller pipes stdout.

## Envelope fields

| Field           | Required        | Notes                                                                                            |
| --------------- | --------------- | ------------------------------------------------------------------------------------------------ |
| `kind`          | yes             | `inline-agent-bundle` or `installable-agent-bundles`. A constant, and the discriminator.         |
| `schemaVersion` | yes             | Semantic version of the payload format. Currently `1.0.0`.                                       |
| `id`            | yes             | The slug the artifact publishes under. Defaults to the bundle or collection name.                |
| `title`         | yes             | Human label for navigation. Defaults to the bundle's `marketplace.displayName`.                  |
| `generatedAt`   | yes             | RFC 3339, UTC.                                                                                   |
| `generator`     | yes             | `{ name, version }` of the tool that produced it.                                                |
| `bundle`        | inline only     | One `DocumentedBundle`.                                                                          |
| `marketplace`   | collection only | The collection from `agent-marketplace.yaml`: name, version, owner, targets.                     |
| `bundles`       | collection only | Every bundle the spec names, **in spec order** — that order is editorial and is not sorted away. |
| `diagnostics`   | collection only | Findings against the spec itself, as distinct from a bundle's own.                               |

## `DocumentedBundle`

| Field                            | Required | Notes                                                                              |
| -------------------------------- | -------- | ---------------------------------------------------------------------------------- |
| `name`, `version`, `description` | yes      | As the manifest spells them.                                                       |
| `manifestSchemaVersion`          | yes      | The source `agent-bundle.yaml`'s own `schemaVersion`. Unrelated to the payload's.  |
| `legacy`                         | yes      | True when the source is a native plugin read through `.claude-plugin/plugin.json`. |
| `source`                         | no       | Path to the bundle root, relative to the repository or collection root.            |
| `marketplace`                    | no       | The manifest's listing block. Absent means the bundle declares none.               |
| `components`                     | yes      | Skills, subagents, rules, hooks, policies, MCP config, assets.                     |
| `graph`                          | yes      | Which components reference which skills.                                           |
| `dependencies`                   | yes      | Declared dependency bundles and the component names they define.                   |
| `targets`                        | yes      | The render matrix.                                                                 |
| `diagnostics`                    | yes      | Findings from parsing and rendering this bundle.                                   |

### Components

Each skill, subagent and rule carries `name`, `description`, `source`, `metadata` and **`body`** —
the Markdown beneath the frontmatter, verbatim and unrendered. The body is the reason this artifact
exists rather than `agent inspect`: a documentation site renders the component from the artifact
without reading the bundle.

`source` is bundle-relative. A component's `files` are rebased to the bundle root too, so every
path in the document is relative to one thing.

A component kind that no selected target emits into a selected profile is **omitted**, not shown
empty. Hooks are plugin-profile only on every target, so an inline artifact has no `hooks` — the
absence is accurate, not a gap.

### The render matrix

`targets[]` holds one entry per host and profile the bundle renders into, each listing the files
that land there with their size and mode. It is produced by the renderer itself rather than
reconstructed from the target profiles, so the artifact cannot claim a layout `agent convert`
would not write.

Content is deliberately excluded. This documents the shape of an installation; it is not a copy of
one.

A host and profile that render nothing are left out rather than listed empty — OpenCode, for one,
declares no plugin-profile install location at all.

### The graph

`graph` is pruned to the components the artifact actually describes, so it never carries an edge
to something that was filtered out. A component may be dropped two ways: its target excluded it,
or its whole kind is unsupported everywhere in the selection. Both prune the graph.

## Diagnostics

Every finding carries the `AB###` code documented in `docs/formats/diagnostic-codes.md`, a
severity, and a `quality` of `exact`, `approximate` or `unsupported`.

An `approximate` mapping is not a failure here. It is the thing these artifacts exist to record:
that a component reaches a host in a changed form. Neither command treats one as a finding, which
is a deliberate departure from the rest of the agent toolset — every Codex bundle carries one, and
the usual rule would make documenting a bundle an error.

## Conformance

```sh
npm run codegen:check   # the composed schemas and generated types match spec/v1
npm test                # the artifacts validate, and match the conformance goldens
```

The gate that matters is `tests/unit/agent-docs.test.ts`: it documents every bundle under
`tests/fixtures/agent/conformance/` and asserts the render matrix equals the `layouts` map in that
fixture's hand-written `expected.json`. The same fact is reached two ways, so a payload that
quietly stopped rendering would agree with itself and disagree with the golden.
