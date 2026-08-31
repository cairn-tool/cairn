# Install manifest

`.cairn-install.json`, written by [`agent install`](../commands/agent/install.md) and
[`agent marketplace --install`](../commands/agent/marketplace.md) at the root of every installed
tree. It is what makes [`agent uninstall`](../commands/agent/uninstall.md)
precise: removal is driven by a recorded inventory, not by a guess about which files in a
merged tree belong to which bundle.

One destination may hold **several** installs — every target declares the same project-scope
merge root, so a repository installing for two hosts, or installing two bundles, records them
side by side. See [Several installs at one destination](#several-installs-at-one-destination).

[`agent installed`](../commands/agent/installed.md) lists what these manifests describe.

## Legacy name

The pre-rename manifest is `.claude-cli-install.json`. Cairn **writes** `.cairn-install.json`
and **reads** either, so an install made before the rename stays removable.

A destination holding **both** files reads as `malformed` rather than picking one — the same
rule as two matching install scopes.

That dual read applies only to paths read off _disk_. Comparisons against a plan this run just
built stay exact equality against the current name, because such a plan never emits the legacy
one. Widening those would be noise, not safety.

## Shape

The document is `generator` plus one or more install records:

```jsonc
{
  "generator": { "name": "@cairn-tool/cairn", "version": "1.12.0" },
  "installs": [
    {
      "bundle": { "name": "release-helper", "version": "1.0.0" },
      "target": "cursor",
      "profile": "plugin",
      "scope": "user",
      "layout": "plugin-dir",
      "mode": "copy",
      "destination": "/Users/me/.cursor/plugins/local/release-helper",
      "files": [
        { "path": "skills/release-helper-prepare-release/SKILL.md", "mode": "0644", "sha256": "…" },
      ],
      "materialized": "/abs/path/to/bundle/.install/cursor-plugin",
      "registration": {
        "file": "/Users/me/.claude/settings.json",
        "marketplaceKey": "release-helper",
        "pluginKey": "release-helper",
      },
    },
  ],
}
```

| Field       | Required | Meaning                    |
| ----------- | -------- | -------------------------- |
| `generator` | yes      | which build wrote the file |
| `installs`  | yes      | one entry per install      |

Each record:

| Field          | Required | Meaning                                                        |
| -------------- | -------- | -------------------------------------------------------------- |
| `kind`         | no       | `bundle` (the default when absent) or `collection`             |
| `bundle`       | yes      | name and version of the installed **unit**                     |
| `collection`   | no       | the plugins a collection placed; absent for a single bundle    |
| `target`       | yes      | `claude-code`, `codex`, `cursor`, `antigravity`, or `opencode` |
| `profile`      | yes      | `plugin` or `project`                                          |
| `scope`        | yes      | `user` or `project`                                            |
| `layout`       | yes      | `plugin-dir`, `merge`, or `marketplace`                        |
| `mode`         | yes      | `copy` or `link`                                               |
| `destination`  | yes      | absolute path of the installed tree                            |
| `files`        | yes      | the inventory; see below                                       |
| `materialized` | no       | present in `link` mode: where the real files live              |
| `registration` | no       | present when host config was edited                            |

A document missing any required field, or with the wrong type for one, reads as `malformed`
rather than being partially trusted — and **one unparseable record makes the whole file
malformed**. The document's job is to be an exhaustive statement of what cairn owns at this
destination; dropping an entry would make its files look unowned to the occupancy check and to
the stale-file prune, which is the destruction this shape exists to prevent.

### Two serializations

A document holding exactly **one** record is written flat, with the record's fields at the top
level beside `generator` — which is also the shape every manifest written before a destination
could hold several has. Two or more records are written under `installs`. Both parse; a
document carrying `bundle` **and** `installs` is `malformed` rather than a guess.

The flat shape is kept for the single-record case so a cairn predating multi-record
destinations keeps working for every plugin-dir install, every marketplace install, and every
single-install project root — nearly all of them.

> **An older cairn reads an `installs` document as `malformed`.** That makes `agent uninstall`
> refuse (`AB806`) rather than mis-remove, which is safe. It also makes `agent install --force`
> overwrite the file and orphan every sibling's inventory, which is not. That path is only
> reachable at a destination holding two or more installs, which could not exist before this
> format.

## Several installs at one destination

Records are told apart by `(bundle.name, target, profile, scope)`. That key is what makes
co-residency safe:

- reinstalling prunes only **its own** stale files, and never a path a sibling record owns;
- `agent uninstall` removes one record and rewrites the file with the rest, deleting the file
  only when the last record goes;
- `agent installed` reports one row per record, so one destination can produce several;
- occupancy is asked **per path**: a destination is not occupied merely because a different
  bundle is recorded there.

Records are ordered by byte comparison of that key, so the bytes never depend on the order
installs happened to be planned in.

### Shared paths

Two installs writing **byte-identical** content to one path — a bundle's assets land at the
destination root for every target — is co-ownership, not a conflict. Both records list the
path, and removing one owner leaves the file for the other.

Two installs writing **different** content to one path is `AB808`. It is reachable: Antigravity
and Codex both declare `.agents/skills/<name>/`, so a bundle whose skill body carries a
conditional block renders two different files to one path. `--force` overrides the form raised
against an install already at the destination; it does **not** override the form raised within
a single run, because `--force` means "overwrite what is there" and cannot make one run write
two byte streams to one path.

`AB809` refuses a `--link` install into a destination that records another install: for a
layout that owns its directory, `--link` replaces the whole destination with a symlink, which
cannot coexist with a sibling.

## Collections

`agent marketplace --install` places several plugins under one marketplace directory, and records
that with `kind: "collection"`:

```jsonc
{
  "kind": "collection",
  "bundle": { "name": "cairn", "version": "1.0.0" },
  "collection": {
    "plugins": [
      { "name": "cairn-markdown", "version": "1.0.0" },
      { "name": "cairn-agent", "version": "1.0.0" },
    ],
  },
  "registration": {
    "file": "/Users/me/.claude/settings.json",
    "marketplaceKey": "cairn",
    "pluginKeys": ["cairn-markdown@cairn", "cairn-agent@cairn"],
  },
}
```

**`bundle` records the installed unit's identity whichever kind it is** — a bundle's, or a
collection's. The install key, `agent uninstall`, and `agent installed` all key off that one
field, so a collection reuses it rather than adding a parallel field they would each have to
learn about. `collection.plugins` is additive detail.

`kind` is absent on every manifest written before collections existed, which is why absent means
`bundle` rather than being an error.

## The inventory

```jsonc
{ "path": "…", "mode": "0644", "sha256": "…" }
```

`path` is relative to `destination`. `mode` is an octal string with a leading zero, the same
spelling used in `conversion-report.json` and `sbom.json`. Entries are sorted by path.

**The manifest excludes itself.** It is written after the inventory is built, and an entry for
it could never be accurate.

This inventory is what `agent uninstall` removes — exactly these paths and nothing else, minus
any path a sibling record still owns — which is what makes a project-scope `merge` install safe
to undo without disturbing files that were already there.

## Modes

**`copy`** writes the rendered files to `destination` directly.

**`link`** materializes the tree once under the bundle's own `.install/` directory and
symlinks the host path at it, so editing the bundle and re-rendering updates the install
without a second copy. `materialized` records where those real files are.

## Registration

Only Claude Code's user-scope marketplace layout needs an activation edit, and `--register` is
the only flag in the toolset that touches host configuration. When it runs, `registration`
records the file edited and the two keys added, so uninstall can reverse exactly that edit.

`marketplaceKey` must match the `name` in the generated catalog document. For a single bundle it
is derived from the bundle name — which is why that catalog's `name` is sourced from the manifest.
For a collection it is the spec's `name`. See
[Claude Code: agent bundles](../providers/claude-code/agent-bundles.md#marketplace-catalog).

A bundle install enables one plugin and records it as `pluginKey`; a collection enables one per
plugin and records them as `pluginKeys`. Both spellings are read, so a manifest written before
collections still reverses cleanly. Uninstall deletes the marketplace key **only** when its
recorded `source.path` is the destination being removed, so an unrelated marketplace registered
under the same name is never touched.

## Diagnostics

Install and uninstall report `AB800`–`AB809`. The recurring conditions are: no install location
for the requested target and scope, a destination that already holds a different bundle, a
`malformed` or missing manifest, and a registration file that could not be read or written.

## Related

- [`agent install`](../commands/agent/install.md),
  [`agent uninstall`](../commands/agent/uninstall.md),
  [`agent installed`](../commands/agent/installed.md)
- [Target profile format](target-profile.md#install) — where install locations are declared
- [Diagnostics](diagnostics.md)
