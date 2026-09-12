---
name: bundle-publishing
description: Package, install, and publish agent bundles with the cairn agent toolset, including building a marketplace of several plugins from a collection spec. Use when preparing a bundle for distribution, installing one locally for testing, or assembling several bundles into one marketplace users add once.
---

# Packaging, installing, and publishing

`cairn` must be on `PATH`. Every command takes `--format llm|human|json` (`-fh`/`-fj`) and exits
`0` clean, `1` on a usage error, `2` when it found something.

Longer conventions: [`${CLAUDE_PLUGIN_ROOT}/assets/cli-basics.md`](../../assets/cli-basics.md).

**Nothing here contacts the network or publishes anything.** These commands produce trees and
checklists; taking an irreversible external action is left to you.

## One bundle: `agent package`

```bash
cairn agent package ./my-bundle --target all --output ./release --archive
cairn agent package ./my-bundle --target codex --output ./release --check --strict
cairn agent package ./my-bundle --target all --output ./release --from-dist ./converted
```

Renders the bundle itself rather than reading an existing tree, so a package can never certify
output that has drifted. `--from-dist` answers the other question — "did CI build what this bundle
produces?" — by rendering in memory and comparing.

Produces the payload plus a marketplace catalog, `sha256sum`-compatible checksums, a file
inventory, and optional byte-reproducible archives.

## Several bundles: `agent marketplace`

`agent package` emits **one catalog per bundle**. Five bundles packaged individually are five
marketplaces a user has to add one at a time. A collection is one:

```yaml
# agent-marketplace.yaml
schemaVersion: "1"
name: my-tools
version: 1.0.0
description: My toolset, as plugins.
owner:
  name: Your Name
targets: [claude-code]
bundles:
  - path: plugins/first
  - path: plugins/second
    exclude: [codex]
```

```bash
cairn agent marketplace agent-marketplace.yaml --output ./dist-plugins
cairn agent marketplace agent-marketplace.yaml --install --register
cairn agent marketplace agent-marketplace.yaml --output ./dist --check --strict
```

`include:`/`exclude:` on a bundle select which targets it is built for. `--target` **narrows** the
spec's targets and may not add to them — the spec is the record of what a collection is for.

The document's `name`, `description`, and `owner` come from the spec; each entry's `author`,
`category`, and `license` still come from its own bundle. Entry `source` paths are relative, so a
published tree names no owner, repo, or branch.

## Installing locally

```bash
cairn agent install ./my-bundle --target cursor --scope user
cairn agent install ./my-bundle --target claude-code --scope user --register
cairn agent install ./my-bundle --target cursor --scope user --link
cairn agent installed
cairn agent uninstall my-bundle --target cursor
```

### One destination may hold several installs

`--target` is repeatable, and every target's project scope resolves to the same merge root, so
a repository can install for two hosts — or install two bundles — into one directory:

```bash
cairn agent install ./my-bundle --target claude-code --target codex --scope project --into .
```

Installs are told apart by `(bundle, target, profile, scope)` in the one `.cairn-install.json`,
so reinstalling one prunes only its own stale files and uninstalling one leaves the other.
**A run is planned in full before anything is written**: if any plan is blocked, nothing is
written for any of them.

Two installs writing byte-identical content to one path — a bundle's assets, which every
target places at the destination root — is co-ownership. Writing _different_ content there is
`AB808`, which is reachable: Antigravity and Codex both declare `.agents/skills/<name>/`.

### A repository can declare its own installs

Put an `agent.install` block in `.cairn.yml`, beside the `agent.verify` block `agent verify`
reads, and the whole in-repo install is one command:

```yaml
agent:
  install:
    targets: [claude-code, codex]
    scope: project
    into: .
    bundles:
      - path: plugins/cairn-markdown
      - path: plugins/cairn-agent
        exclude: [codex]
```

```bash
cairn agent install                       # walks up for .cairn.yml
cairn agent install --config other.yml    # names one explicitly
```

`--target` there **narrows** the block and may not name a target it omits, the same rule
`agent marketplace` uses. Prefer this over `agent convert` plus a copy: a copied tree has no
install manifest, so a file the bundle stops rendering is never flagged.

**`--register` is the only flag that edits host config**, and only Claude Code's marketplace
layout needs it. Without it the tree is still written and the exact required edit is reported as
`AB805`.

Registering is necessary but not sufficient: Claude Code validates the catalog those keys point
at and, if it fails, drops the marketplace **and prunes the settings entries** — so a bad catalog
looks exactly like a `--register` that never ran. Verify with
`claude plugin validate ~/.claude/plugins/marketplaces/<name>`.

`--link` materializes the render once under the bundle's `.install/` tree and symlinks the host
path at it, so edits are live. Use it while writing content.

### Bundle install and collection install differ

`agent install --register` keys the marketplace on the **bundle** name, so installing five bundles
gives five marketplaces. `agent marketplace --install --register` registers one marketplace
enabling every plugin. Do not do both for the same plugin: you get two offers of it under
different keys and a doubled skill list.

## `AB500` is the failure to expect

Claude Code refuses a catalog with no top-level `owner`, sourced from `marketplace.publisher` —
and `agent init` scaffolds `publisher.name: ""`, which validates cleanly. So a bundle can pass
`agent validate` for weeks and fail the moment you package it.

Codex additionally **requires** `marketplace.icon`. A bundle without one packages for Claude Code
and Cursor and fails for Codex.

Fix the manifest; do not work around the catalog.

## Deterministic archives

`--archive` writes ustar `.tar.gz` files built to be byte-identical across runs and machines:
zeroed mtimes and ownership, normalized modes, entries sorted by **byte** comparison rather than
locale, and a zeroed gzip header. A path that will not fit a ustar header is refused rather than
escalated to a PAX record.

## More

Catalog field tables, install locations per target, and every `AB5xx`/`AB8xx`/`AB9xx` code are in
[`reference/marketplace.md`](reference/marketplace.md).
