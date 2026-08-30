# Cairn's own plugins

Cairn ships its toolsets as installable plugins, so an assistant working in a repository has the
command surface available without rediscovering it from `--help` every session.

They are authored as [agent bundles](formats/agent-bundle.md) under `plugins/`, collected by
[`agent-marketplace.yaml`](formats/agent-marketplace.md) at the repository root, and built with
[`agent marketplace`](commands/agent/marketplace.md) — the same commands the plugins document.

## Installing

```text
/plugin marketplace add cairn-tool/cairn@claude-plugins
/plugin install cairn-markdown@cairn
```

The branch is force-pushed on every release. Nothing on it names an owner or a branch: catalog
entry sources are relative, so the tree works however it was fetched.

**The `cairn` binary is a separate install.** These plugins document and invoke it; they do not
carry it. See [the README](https://github.com/cairn-tool/cairn#install). A plugin whose hook
cannot find `cairn` on `PATH` exits quietly rather than failing an edit.

## The plugins

| Plugin           | Covers                                                                  | Extras              |
| ---------------- | ----------------------------------------------------------------------- | ------------------- |
| `cairn-markdown` | The `md` toolset: linting, structure, workspace queries, safe refactors | subagent, hook, MCP |
| `cairn-scripts`  | `scripts run\|which\|list`, and authoring a `.cairn.yml` registry       | —                   |
| `cairn-usage`    | The 13 `usage` reports, the store, and each provider's log quirks       | subagent            |
| `cairn-archive`  | `archive run\|status\|list\|extract\|verify\|migrate`                   | —                   |
| `cairn-agent`    | The 17 `agent` commands: authoring, testing, and publishing bundles     | subagent            |

Each carries model-invoked skills for the workflows and explicit skills that appear as slash
commands. Skill bodies stay short; full flag tables live in `reference/` sidecars that load only
when a skill points at one.

The extras are added where they earn their place, not uniformly:

- **`cairn-markdown` ships a `PostToolUse` hook** that lints a `.md` file right after it is
  written. It resolves `cairn` from `PATH` and exits 0 if it is absent, so it can never block an
  edit.
- **`cairn-markdown` registers `cairn serve mcp`**, exposing the read-only workspace engine's
  eleven tools as `mcp__plugin_cairn-markdown_cairn__*`. It ships there and nowhere else: those
  tools are all Markdown tools, so registering the same server in five plugins would register the
  same eleven tools five times.
- **`cairn-scripts` and `cairn-archive` deliberately carry neither.** Three commands do not
  justify a subagent, and `archive run` can run for minutes and write gigabytes — it must never
  fire implicitly.

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
every bundle, then builds the collection under `--strict` and uploads it as an artifact — so a
reviewer can `/plugin marketplace add` a PR's tree.

`.github/workflows/plugins.yml` publishes. It is gated on the **Release** workflow rather than on
CI, because semantic-release has committed the version bump by then. It builds into a temp
directory, initializes a fresh repository there, and force-pushes a single commit, which keeps the
published branch free of source history.

## Related

- [`agent marketplace`](commands/agent/marketplace.md) — the command that builds the collection
- [Marketplace spec](formats/agent-marketplace.md) — `agent-marketplace.yaml`
- [Agent bundle format](formats/agent-bundle.md) — how each plugin is authored
- [Install manifest](formats/install-manifest.md) — what an install records
