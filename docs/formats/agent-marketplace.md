# Marketplace spec format

The file [`agent marketplace`](../commands/agent/marketplace.md) reads: which bundles a collection
contains, which targets it is built for, and which bundles are skipped for which target.

It is the collection-level sibling of [`agent-bundle.yaml`](agent-bundle.md). A bundle describes
one plugin; a spec describes the marketplace several of them are offered through.

## Schema version

`schemaVersion` is a **hand-owned** version of the source format authors write. It is the sixth in
this project and is unrelated to the package version, to `CONTRACT_VERSION`, to
`PROFILE_SCHEMA_VERSION`, to the bundle `schemaVersion`, or to the test-file one. See
[the contract](../contract.md). semantic-release does not touch it.

| Value | Meaning      |
| ----- | ------------ |
| `1`   | The current. |

An unsupported value raises `AB900`.

## The document

```yaml
schemaVersion: "1"
name: cairn
version: 1.0.0
description: Cairn's own toolsets, as plugins.
owner:
  name: Bryan Stockus
  url: https://github.com/bstockus

targets: [claude-code]

bundles:
  - path: plugins/cairn-markdown
  - path: plugins/cairn-usage
    exclude: [codex]
  - path: plugins/cairn-agent
    include: [claude-code]
```

| Field           | Required | Rules                                                                |
| --------------- | -------- | -------------------------------------------------------------------- |
| `schemaVersion` | yes      | `"1"` — otherwise `AB900`                                            |
| `name`          | yes      | lowercase kebab-case, `^[a-z0-9]+(-[a-z0-9]+)*$` — otherwise `AB902` |
| `version`       | yes      | semantic version — otherwise `AB902`                                 |
| `description`   | no       | a string                                                             |
| `owner`         | yes      | `{ name, url?, email? }`; `name` is required                         |
| `targets`       | yes      | array of known target ids, or `[all]`                                |
| `bundles`       | yes      | non-empty array of bundle entries                                    |

A missing or empty required field raises `AB901`; a malformed one, or an unknown key at any level,
raises `AB902`.

### `name` is the key hosts index by

It becomes the catalog's `name` and, for a host that registers marketplaces by key, the
`extraKnownMarketplaces` key — so a plugin's install id is `<plugin>@<name>`. Claude Code enforces
that the catalog `name` match the key it was registered under, so the two agree by construction.

### `owner` is the collection's, not a bundle's

Claude Code refuses a catalog with no `owner`. It is declared here rather than read from a
bundle's `marketplace.publisher` because a collection's owner is a property of the collection;
resolving it from a bundle would name the marketplace after whichever one sorted first.

Each bundle's own `marketplace.publisher` still supplies its **entry** `author`, unchanged.

### No `profile` field

A catalog only ever describes plugins, so a collection is inherently a plugin-profile artifact.
Offering the knob would only offer a way to get nothing.

## Bundle entries

```yaml
bundles:
  - path: plugins/cairn-usage
    exclude: [codex]
```

| Field     | Required | Rules                                                       |
| --------- | -------- | ----------------------------------------------------------- |
| `path`    | yes      | Spec-relative path to a bundle root                         |
| `include` | no       | Array of target ids this bundle is built for, and no others |
| `exclude` | no       | Array of target ids it is not built for                     |

`include` and `exclude` mirror the [component frontmatter](agent-bundle.md#component-frontmatter-shared-by-all-kinds)
convention, so an author already knows them. Declaring **both** on one entry raises `AB903` — they
are not combined.

**Paths resolve from the spec file's directory and must stay inside it**, including after
resolving symlinks. A path that escapes, or a symlink whose target escapes, is refused rather than
followed — the same containment rule component paths inside a bundle follow. A missing path, a
path that is not a directory, or one that escapes raises `AB904`.

Two entries resolving to the same directory, or to two bundles with the same `name`, raise
`AB905`: a host resolves a duplicated plugin name arbitrarily.

## Targets

`targets` selects the hosts a catalog is built for. `all` expands to every known target and is the
same spelling `--target all` accepts, so a spec and a flag never disagree about what "everything"
means.

Only `claude-code`, `codex`, and `cursor` declare a marketplace catalog. A selected target that
declares none reports `AB507` — the same code `agent package` uses for "this target produces no
catalog" — rather than silently emitting payloads and no catalog.

A target left with no bundles after include/exclude raises `AB906`.

## Related

- [`agent marketplace`](../commands/agent/marketplace.md) — the command that reads this
- [Agent bundle format](agent-bundle.md) — the per-plugin source
- [Package](package.md) — the single-bundle packaging stage
- [Diagnostics](diagnostics.md) — the `AB###` codes referenced throughout
