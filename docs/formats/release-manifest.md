# Release manifest

`release-manifest.json`, written at the root of a
[`agent marketplace --layout release`](../commands/agent/marketplace.md#release-layout) tree.

It answers the one question a consumer of a published branch has and the catalogs cannot: **what is
on this branch, and how do I install each piece of it?** A host catalog describes only that host,
and only the hosts that have catalogs at all. This describes the release.

## Who reads it

A tool that installs a whole branch rather than adding a marketplace — cloning the `release` branch
and installing every bundle for every host it supports. Kwik Trip's `kps global install` is the
first such consumer.

It is **not** read by Claude Code, Cursor or Codex. Those read their own catalogs, and nothing here
is required for a marketplace install to work.

## Shape

```json
{
  "schemaVersion": "1",
  "marketplace": "cairn",
  "version": "1.2.0",
  "description": "Cairn's own toolsets, as plugins.",
  "sourceCommit": "31a871b5b9617e0…",
  "generator": { "name": "@cairn-tool/cairn", "version": "4.3.0" },
  "targets": {
    "claude-code": {
      "catalog": ".claude-plugin/marketplace.json",
      "root": "claude-code",
      "activation": "settings"
    },
    "codex": {
      "catalog": ".agents/plugins/marketplace.json",
      "root": "codex",
      "activation": "cli:codex"
    },
    "cursor": {
      "catalog": ".cursor-plugin/marketplace.json",
      "root": "cursor",
      "activation": null
    },
    "antigravity": { "catalog": null, "root": "antigravity", "activation": null }
  },
  "bundles": [
    {
      "name": "cairn-markdown",
      "version": "1.1.0",
      "description": "Validate, analyze, and refactor Markdown with the cairn md toolset.",
      "source": "bundles/cairn-markdown",
      "sourceSha256": "5c1d217cbcb8…",
      "targets": {
        "claude-code": { "path": "claude-code/cairn-markdown", "sha256": "…" },
        "cursor": { "path": "cursor/cairn-markdown", "sha256": "…" }
      }
    }
  ]
}
```

## `targets` — what the branch offers each host

| Field        | Meaning                                                                                                                                        |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `catalog`    | Path of that host's aggregated catalog, or `null` when the host has no marketplace concept.                                                    |
| `root`       | Directory holding that host's rendered trees, or `null` when nothing was rendered for it.                                                      |
| `activation` | `settings` when the host is activated by a config edit, `cli:<command>` when it needs a CLI, `null` when its plugin directory is auto-scanned. |

**`catalog: null` does not mean the target is unsupported.** It means the only way to install for
it is from `source` — which is exactly why the source bundles are published. Antigravity is served
that way.

**`activation` is not derivable from `catalog`.** Cursor publishes a catalog and needs no
activation, because it auto-scans its plugin directory. A consumer that inferred one from the other
would pass `--register` where it does nothing and omit it where it is required.

## `bundles` — an array, not a map

Ordered as the collection spec declares them, so two builds of one tree produce one document. Each
entry is self-describing, and a consumer iterating the list never depends on JSON object key order.

`version` is the **bundle's** version. It equals the release `version` only when the release was
built with `--stamp-version`; a repository whose bundles carry their own versions publishes them
unchanged, and they will differ from each other and from the release.

`targets` lists only the targets that bundle is built for. A bundle excluded for a host through the
spec's `include`/`exclude` is absent from that host's entry here, from that host's catalog, and
from that host's rendered tree — the three cannot disagree, because one build writes all of them.

## `sourceSha256` versus the per-target `sha256`

The per-target `sha256` digests a **rendered** tree. `sourceSha256` digests the published source
bundle, which is what a from-source install actually reads. A consumer verifying what it installs
wants `sourceSha256`; one verifying what a marketplace serves wants the per-target digest.

Both are sha256 over the subtree, taken in byte-sorted POSIX path order, of each file's path, a
flag for whether it is executable, and its contents.

> Digests are comparable **within** a release, never across one. They depend on the exact
> construction above, and nothing in this project compares a digest to one from an earlier release.

## Versions

`schemaVersion` is hand-owned and versions this document alone. It is unrelated to the package
version, to the bundle `schemaVersion`, to the collection spec's, or to any other version in this
project — see [the contract](../contract.md).

`sourceCommit` is whatever `--source-commit` was given, or `null`. Cairn never runs `git` itself, so
a publisher that wants the field passes it.

## See also

- [`agent marketplace`](../commands/agent/marketplace.md) — the command that writes it
- [`agent-marketplace.yaml`](agent-marketplace.md) — the spec it is built from
- [Install manifest](install-manifest.md) — what an _installed_ tree records, which is a different
  document for a different question
