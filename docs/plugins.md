# Cairn's own plugins

Cairn ships its toolsets as installable plugins, so an assistant working in a repository has the
command surface available without rediscovering it from `--help` every session.

They are authored as [agent bundles](formats/agent-bundle.md) under `plugins/`, collected by
[`agent-marketplace.yaml`](formats/agent-marketplace.md) at the repository root, and built with
[`agent marketplace`](commands/agent/marketplace.md) — the same commands the plugins document.

## Installing

One branch per host, each holding that host's catalog at its root:

| Target        | Branch           | Catalog                           |
| ------------- | ---------------- | --------------------------------- |
| `claude-code` | `claude-plugins` | `.claude-plugin/marketplace.json` |
| `codex`       | `codex-plugins`  | `.codex-plugin/marketplace.json`  |
| `cursor`      | `cursor-plugins` | `.cursor-plugin/marketplace.json` |

All three catalogs carry the same document-level `name`, `cairn` — it comes from the collection
spec, not from the target — so a plugin's install id is `<plugin>@cairn` on every host that uses
one.

### Claude Code

```text
/plugin marketplace add cairn-tool/cairn@claude-plugins
/plugin install cairn-markdown@cairn
```

### Codex

`--ref` is what pins the marketplace to the published branch; without it Codex fetches the
repository's default branch, which carries the bundle sources rather than a catalog:

```bash
codex plugin marketplace add cairn-tool/cairn --ref codex-plugins
codex plugin add cairn-markdown@cairn
```

Codex installs from a **local snapshot** of the catalog, under
`$CODEX_HOME/marketplaces/cairn`, and only a configured marketplace is an install source — a
`.codex-plugin/marketplace.json` sitting in the working directory is not. So a release does not
reach an existing install by itself: `codex plugin marketplace upgrade cairn` re-fetches the
branch, and `codex plugin list --marketplace cairn` shows what the snapshot currently offers.

### Cursor

Cursor has no CLI for adding a marketplace, and a repository-backed one is a **team
marketplace** — a Teams or Enterprise feature. In the dashboard, go to **Plugins → Team
Marketplaces → Add Marketplace → Import from Repo**, point it at
`https://github.com/cairn-tool/cairn` and the `cursor-plugins` branch, and developers then
install from **Customize** in the sidebar. **Auto Refresh** re-reads the whole catalog on every
push to that branch, and needs the Cursor GitHub App installed on the repository.

Without a team plan, install locally instead — the wrapper below writes to
`~/.cursor/plugins/local`, which Cursor scans on startup and which needs no registration:

```bash
scripts/install-cursor.sh
```

### The rest

`claude-code`'s branch is **not** `claude-code-plugins`. That name predates the other two and is
already added in users' clients, so it stays pinned; only the two new branches derive their name
from the target.

Antigravity and OpenCode have no marketplace concept, so there is no branch for them — a plugin
there is a directory drop. Use the [install scripts](https://github.com/cairn-tool/cairn/blob/main/scripts/README.md)
or [`agent install`](commands/agent/install.md).

Each branch is force-pushed on every release. Nothing on one names an owner or a branch: catalog
entry sources are relative, so a tree works however it was fetched.

**The `cairn` binary is a separate install.** These plugins document and invoke it; they do not
carry it. See [the README](https://github.com/cairn-tool/cairn#install). A plugin whose hook
cannot find `cairn` on `PATH` exits quietly rather than failing an edit.

## The plugins

| Plugin                                        | Covers                                                                  | Page                                        |
| --------------------------------------------- | ----------------------------------------------------------------------- | ------------------------------------------- |
| [`cairn-markdown`](plugins/cairn-markdown.md) | The `md` toolset: linting, structure, workspace queries, safe refactors | [cairn-markdown](plugins/cairn-markdown.md) |
| [`cairn-scripts`](plugins/cairn-scripts.md)   | `scripts run\|which\|list`, and authoring a `.cairn.yml` registry       | [cairn-scripts](plugins/cairn-scripts.md)   |
| [`cairn-usage`](plugins/cairn-usage.md)       | The 13 `usage` reports, the store, and each provider's log quirks       | [cairn-usage](plugins/cairn-usage.md)       |
| [`cairn-archive`](plugins/cairn-archive.md)   | `archive run\|status\|list\|extract\|verify\|migrate`                   | [cairn-archive](plugins/cairn-archive.md)   |
| [`cairn-agent`](plugins/cairn-agent.md)       | The 18 `agent` commands: authoring, migrating, testing, publishing      | [cairn-agent](plugins/cairn-agent.md)       |
| [`cairn-jira`](plugins/cairn-jira.md)         | `jira adf` in both directions, and what each conversion costs           | [cairn-jira](plugins/cairn-jira.md)         |
| [`cairn-pdf`](plugins/cairn-pdf.md)           | `pdf inspect\|text\|outline\|validate\|to-markdown`                     | [cairn-pdf](plugins/cairn-pdf.md)           |

Each carries model-invoked skills for the workflows and explicit skills that appear as slash
commands. Skill bodies stay short; full flag tables live in `reference/` sidecars that load only
when a skill points at one.

The extras — a subagent, a hook, an MCP server — are added where they earn their place, not
uniformly. Each plugin's page says what it has and, where it has none, why.

## Pages

One page per plugin, each carrying the same sections in the same order — including the empty
ones, so "this plugin has no hook" and "nobody has written one yet" stay different answers.

- [cairn-markdown](plugins/cairn-markdown.md)
- [cairn-scripts](plugins/cairn-scripts.md)
- [cairn-usage](plugins/cairn-usage.md)
- [cairn-archive](plugins/cairn-archive.md)
- [cairn-agent](plugins/cairn-agent.md)
- [cairn-jira](plugins/cairn-jira.md)

`cairn-agent` is a worked example of what it documents: its own source is a bundle, and
`agent-marketplace.yaml` at the repository root is a collection spec.

## Building locally

```bash
npm run build

# Build the collection into a tree.
node dist/cli.js agent marketplace agent-marketplace.yaml --output ./dist-plugins

# Or install and activate it directly.
node dist/cli.js agent marketplace agent-marketplace.yaml --install --register
```

`--install --register` writes to `~/.claude/plugins/marketplaces/cairn` and adds one
`extraKnownMarketplaces` key plus one `enabledPlugins` entry per plugin. Reverse it with
`cairn agent uninstall cairn --target claude-code`.

The build emits one tree per declared target — `dist-plugins/claude-code/`,
`dist-plugins/codex/`, `dist-plugins/cursor/` — and each is what its branch publishes.

## Installing on your own machine

One wrapper script per host lives in
[`scripts/`](https://github.com/cairn-tool/cairn/blob/main/scripts/README.md), so a developer does
not have to remember which scope each host supports:

```bash
scripts/install-claude-code.sh              # the whole collection, registered
scripts/install-cursor.sh                   # ~/.cursor/plugins/local
scripts/install-antigravity.sh              # ~/.gemini/config/plugins
scripts/install-codex.sh   --into ~/src/app # project scope; Codex has no user scope
scripts/install-opencode.sh --into ~/src/app
```

Each takes `--dry-run`, `--check`, `--uninstall`, and a list of bundle names. Codex and OpenCode
declare no user-scope location, and those two scripts refuse `--scope user` rather than writing
where the host will not look.

For iterating on a single plugin's content, `claude --plugin-dir dist-plugins/claude-code/cairn-markdown`
plus `/reload-plugins` avoids the marketplace and the plugin cache entirely.

## Versions

Each bundle's `version:` and the collection's are **hand-owned and independent of the CLI
version**. semantic-release owns `package.json`; it does not touch these.

They are deliberately not tracked to the CLI release. `AB501` errors when a catalog version
disagrees with its bundle, so tracking would mean editing the bundle manifests inside CI and
pushing back to `main` — racing semantic-release's own commit. And the CLI releases on every
`fix:`, so a patch unrelated to any plugin would bump all of them and train users to ignore the
number.

Bump a bundle's `version:` in the same commit that changes its content.

Use `chore(plugins):` or `docs(plugins):` for plugin-content-only changes. `feat(plugins):` would
mint a minor **CLI** release for a SKILL.md edit.

## How it is built and published

`.github/workflows/ci.yml` runs `agent validate`, `convert`, `doctor`, `test`, and `audit` over
every bundle **for all five targets**, then builds the collection under `--strict` and uploads it
as an artifact — so a reviewer can `/plugin marketplace add` a PR's tree.

The per-target sweep is `scripts/check-bundles.sh`, which runs locally unchanged. It gates on
`error` diagnostics rather than on the exit code for every target except `claude-code`, because
`agent validate` and `agent convert` fail on any `approximate` diagnostic and the other four
hosts carry those inherently. Only `claude-code` is held to an exit-0 bar.

`.github/workflows/plugins.yml` publishes **one branch per target**: it builds the collection
once and force-pushes each target tree to its own branch, because the catalog sits at a tree's
root and so two trees cannot share one branch without moving it. `workflow_dispatch` takes a
`targets` input to republish a subset.

Publishing covers the three targets that declare a marketplace catalog. `antigravity` and
`opencode` have no marketplace concept, so they are absent from `agent-marketplace.yaml` — while
`scripts/check-bundles.sh` still renders every bundle for all five.

Neither the CI build nor the publish build passes `--strict` any more, because Codex and Cursor
carry `approximate` diagnostics inherently. `agent marketplace` still blocks on **errors**
without it — a missing catalog field is `AB500` and a missing icon is `AB502`, both errors — and
CI additionally builds the Claude Code tree alone under `--strict` to keep its zero-warning bar.

`.github/workflows/plugins.yml` publishes. It is gated on the **Release** workflow rather than on
CI, because semantic-release has committed the version bump by then. It builds into a temp
directory, initializes a fresh repository there, and force-pushes a single commit, which keeps the
published branch free of source history.

## Related

- [`agent marketplace`](commands/agent/marketplace.md) — the command that builds the collection
- [Marketplace spec](formats/agent-marketplace.md) — `agent-marketplace.yaml`
- [Agent bundle format](formats/agent-bundle.md) — how each plugin is authored
- [Install manifest](formats/install-manifest.md) — what an install records
- [`agent verify`](commands/agent/verify.md) — checking a committed tree against the bundle it came from
