# `agent marketplace`

## Synopsis

```text
cairn agent marketplace <spec> --output <dir> [options]
```

Builds a **collection**: several bundles rendered together, with **one aggregated catalog per
target** rather than one catalog per bundle. Which bundles, which targets, and which bundles are
skipped for which target are declared in an
[`agent-marketplace.yaml`](../../formats/agent-marketplace.md) spec file.

[`agent package`](package.md) answers "is this bundle publishable?" and emits a one-entry catalog
per bundle. This answers "what does this marketplace offer?", which is a different document: five
bundles packaged individually are five marketplaces a user has to add one at a time.

Like `agent package`, it **never contacts the network and never publishes.** It produces a tree;
taking an irreversible external action is left to you.

**Stability: experimental.** The payload shape may change before it hardens.

## Arguments

| Argument | Required | Description                                                        |
| -------- | -------- | ------------------------------------------------------------------ |
| `spec`   | Yes      | The spec file, or a directory holding an `agent-marketplace.yaml`. |

## Options

| Option                 | Default  | Description                                                         |
| ---------------------- | -------- | ------------------------------------------------------------------- |
| `--output <dir>`       | Required | Collection root. Must not be inside any bundle.                     |
| `--target <target>`    | The spec | Repeatable. **Narrows** the spec's targets; may not add to them.    |
| `--marketplace <mode>` | `repo`   | Catalog mode: `repo` or `local`.                                    |
| `--archive`            | Off      | Also emit a deterministic `.tar.gz` per plugin.                     |
| `--install`            | Off      | Install into the host marketplace directory the profile declares.   |
| `--scope <scope>`      | `user`   | `user` or `project`. `--install` only.                              |
| `--into <dir>`         | Profile  | Override the install root. `--install` only.                        |
| `--link`               | Off      | Symlink the installed tree instead of copying it. `--install` only. |
| `--register`           | Off      | Edit host config to activate the collection. `--install` only.      |
| `--strict`             | Off      | Treat warnings as blocking findings.                                |
| `--force`              | Off      | Replace a nonempty destination.                                     |
| `--dry-run`            | Off      | Build in memory without writing.                                    |
| `--check`              | Off      | Compare against an existing collection without writing.             |
| `--format <fmt>`       | `llm`    | Output as `llm`, `human`, or `json`. Shorthands: `-fh`, `-fj`.      |
| `--envelope`           | Off      | Wrap `--format json` output in the versioned result envelope.       |

`--check` and `--dry-run` cannot be combined.

`agent package`'s third catalog mode, `none`, is deliberately absent: a collection whose whole
product is a catalog has nothing left when the catalog is suppressed.

## `--target` narrows, never widens

The spec is the record of what a collection is for. A flag that could **add** a target would let
CI publish for a host the spec never declared, so naming an undeclared target is an invocation
error rather than a silent extra build.

## It renders the bundles itself

Same rule as `agent package`: every bundle is rendered in memory rather than read from an existing
`agent convert` tree, so a catalog can never certify output that has drifted. `--check`
re-renders and compares.

## Collection layout

```text
<output>/
  <target>/
    .claude-plugin/marketplace.json   the aggregated catalog, N entries
    <plugin>/                         one rendered plugin payload per bundle
      .claude-plugin/plugin.json
      skills/  agents/  hooks/  .mcp.json  assets/
  archives/<plugin>-<version>-<target>-plugin.tar.gz   with --archive
  checksums.sha256
  sbom.json
  marketplace-report.json
```

> The collection root is **not** an `agent convert` output root. Do not point
> `agent doctor --output` at it — the catalog and integrity files are not conversion artifacts and
> would be reported as unmanaged.

**No per-plugin `marketplace.json`.** `agent package` writes a one-entry catalog inside each
payload it renders, because there the payload root _is_ the marketplace root. A collection's
catalog sits one level above N plugin directories, so only the collection root carries one.

## `--install` registers one marketplace, not one per plugin

This is the gap the flag exists to close. [`agent install --register`](install.md) derives the
`extraKnownMarketplaces` key from the **bundle** name, so installing five bundles leaves a user
with five marketplaces, each offering one plugin. A collection registers **one** key — the spec's
`name` — and enables every plugin under it:

```json
{
  "extraKnownMarketplaces": {
    "cairn": { "source": { "source": "directory", "path": "~/.claude/plugins/marketplaces/cairn" } }
  },
  "enabledPlugins": { "cairn-markdown@cairn": true, "cairn-agent@cairn": true }
}
```

`--register` is the only flag that edits host config, exactly as in `agent install`. Without it
the tree is still written and the required edit is reported as `AB805`.

Registering **both** an individual bundle and a collection containing it leaves two marketplaces
offering the same plugin under different keys (`cairn-markdown@cairn-markdown` and
`cairn-markdown@cairn`) and a doubled skill list. Uninstall one of them.

### The installed-state manifest

The destination gets a `.cairn-install.json` with `kind: "collection"`, the collection's identity
under `bundle`, and the plugins it placed under `collection.plugins`. `bundle` records the
_installed unit's_ identity whichever kind it is, which is why
[`agent uninstall <name>`](uninstall.md) and [`agent installed`](installed.md) work on a
collection with no special handling. Uninstalling removes exactly the recorded inventory and
reverts the marketplace key **and** every plugin key it enabled.

## Where each catalog field comes from

Entry fields resolve per bundle from the target profile, exactly as in `agent package` — so
Claude Code's singular `category` (the first of the bundle's `categories`) and its object-shaped
`author` keep working, with no per-target branching here.

Document fields come from the **spec**, not from any bundle:

| Catalog key   | Source             |
| ------------- | ------------------ |
| `name`        | spec `name`        |
| `description` | spec `description` |
| `owner`       | spec `owner`       |

A collection's identity belongs to the collection. Resolving it from a bundle would name the
marketplace after whichever one sorted first.

Each entry's `source` is `./<plugin>` — **relative**, so the published tree names no owner, repo,
or branch and works however it was fetched.

## Only three targets have a catalog

`claude-code`, `codex`, and `cursor` declare one. `antigravity` and `opencode` do not, and a
selected target that declares none reports `AB507` rather than silently producing payloads and no
catalog. Codex additionally **requires** a `marketplace.icon`, so a bundle without one packages for
the other two and fails for Codex.

## Diagnostics

Codes in the `AB9xx` block are the collection's own; everything else is forwarded unchanged from
the render and catalog stages, so a suppression list means the same thing whichever command
produced it.

| Code    | Severity | Meaning                                                       |
| ------- | -------- | ------------------------------------------------------------- |
| `AB900` | error    | Unsupported spec `schemaVersion`.                             |
| `AB901` | error    | A required spec field is missing or empty.                    |
| `AB902` | error    | A spec field is malformed, or names an unknown target or key. |
| `AB903` | error    | A bundle declares both `include` and `exclude`.               |
| `AB904` | error    | A bundle path is missing, is not a directory, or escapes.     |
| `AB905` | error    | Two bundles resolve to the same directory or the same name.   |
| `AB906` | warning  | A selected target has no bundles left after include/exclude.  |
| `AB907` | notice   | A bundle was skipped for a target by its own include/exclude. |

A spec error stops before rendering: building against half-validated data would report a
confusing second wave of failures.

`AB907` is a **notice**, not a warning. An exclusion is the author saying so, and a warning would
block `--strict` for a collection working exactly as declared.

Approximate render diagnostics alone do **not** fail a build — a Codex bundle inherently carries
them. Only errors, and warnings under `--strict`, fail.

## Examples

```bash
# Build every target the spec declares.
cairn agent marketplace agent-marketplace.yaml --output ./dist-plugins

# One target, with archives.
cairn agent marketplace . --output ./dist-plugins --target claude-code --archive

# Install locally and activate it, without writing a tree at all.
cairn agent marketplace agent-marketplace.yaml --install --register

# CI gate: no writes, exit 2 on any finding or drift.
cairn agent marketplace agent-marketplace.yaml --output ./dist-plugins --check --strict

# What is stopping this from shipping?
cairn agent marketplace agent-marketplace.yaml --output ./dist --dry-run -fj \
  | jq '.diagnostics[] | select(.severity == "error")'
```

`--install` and `--register` do the same thing `/plugin marketplace add` does, without leaving the
shell. To add a built tree by hand instead:

```text
/plugin marketplace add /absolute/path/to/dist-plugins/claude-code
```

## Exit codes

| Code | Meaning                                    |
| ---- | ------------------------------------------ |
| `0`  | Collection written, or checks passed.      |
| `1`  | Invocation, path, or I/O error.            |
| `2`  | Spec, publish-readiness, or stale finding. |

## Related

- [`agent package`](package.md) — the single-bundle stage this builds on
- [Marketplace spec format](../../formats/agent-marketplace.md) — the file this reads
- [`agent install`](install.md) — placing a single bundle where a host scans
