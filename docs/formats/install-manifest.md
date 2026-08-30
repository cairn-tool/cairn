# Install manifest

`.cairn-install.json`, written by [`agent install`](../commands/agent/install.md) and
[`agent marketplace --install`](../commands/agent/marketplace.md) at the root of every installed
tree. It is what makes [`agent uninstall`](../commands/agent/uninstall.md)
precise: removal is driven by a recorded inventory, not by a guess about which files in a
merged tree belong to which bundle.

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

```jsonc
{
  "generator": { "name": "@bstockus/cairn", "version": "1.12.0" },
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
}
```

| Field          | Required | Meaning                                                        |
| -------------- | -------- | -------------------------------------------------------------- |
| `generator`    | yes      | which build wrote it                                           |
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
rather than being partially trusted.

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
collection's. The occupied-destination check, `agent uninstall`, and `agent installed` all key off
that one field, so a collection reuses it rather than adding a parallel field they would each have
to learn about. `collection.plugins` is additive detail.

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

This inventory is what `agent uninstall` removes — exactly these paths and nothing else — which
is what makes a project-scope `merge` install safe to undo without disturbing files that were
already there.

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

Install and uninstall report `AB800`–`AB807`. The recurring conditions are: no install location
for the requested target and scope, a destination that already holds a different bundle, a
`malformed` or missing manifest, and a registration file that could not be read or written.

## Related

- [`agent install`](../commands/agent/install.md),
  [`agent uninstall`](../commands/agent/uninstall.md),
  [`agent installed`](../commands/agent/installed.md)
- [Target profile format](target-profile.md#install) — where install locations are declared
- [Diagnostics](diagnostics.md)
