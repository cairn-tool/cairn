# Documentation contents

This directory is the reference documentation for `cairn`.

## Reference

- [Complete command listing](commands.md)
- [Guides](guide.md)
- [Machine-readable result contract](contract.md)
- [Project configuration schema](configuration.md)
- [File formats and schemas](formats.md)
- [Providers](providers.md)
- [Cairn's own plugins](plugins.md)
- [Shared Markdown command behavior](commands/md/common.md)
- [Shared usage command behavior](commands/usage/common.md)
- [Shared archive command behavior](commands/archive/common.md)

## Project

- [Installing Cairn](install.md)
- [Migrating from claude-cli](migration.md)
- [Update checks](update-checks.md)
- [Development](development.md)
- [Releasing](releasing.md)

## Guides

Why each toolset exists, and the facts that make its answers trustworthy.

- [Agent bundles](guide/agent-bundles.md)
- [Markdown](guide/markdown.md)
- [Named scripts](guide/scripts.md)
- [Usage reporting](guide/usage.md)
- [Long-term archiving](guide/archiving.md)

## File formats

Formats Cairn itself owns: what each file contains, which version governs it, and what may
change without breaking a consumer.

- [Agent bundle](formats/agent-bundle.md)
- [Bundle contract tests](formats/agent-tests.md)
- [Marketplace spec](formats/agent-marketplace.md)
- [Target profile](formats/target-profile.md)
- [Conversion output](formats/conversion-output.md)
- [Package](formats/package.md)
- [Install manifest](formats/install-manifest.md)
- [Usage store](formats/usage-store.md)
- [Archive store](formats/archive-store.md)
- [Deterministic tar](formats/deterministic-tar.md)
- [Markdown conventions](formats/markdown-conventions.md)
- [Audit baselines](formats/audit-baseline.md)
- [Diagnostics](formats/diagnostics.md)
- [Diagnostic codes](formats/diagnostic-codes.md)

## Providers

What is known about each assistant Cairn renders for, reads logs from, or archives.

### Claude Code

- [Overview](providers/claude-code/overview.md)
- [Agent bundles](providers/claude-code/agent-bundles.md)
- [Usage logs](providers/claude-code/usage-logs.md)
- [Archiving](providers/claude-code/archiving.md)

### Codex

- [Overview](providers/codex/overview.md)
- [Agent bundles](providers/codex/agent-bundles.md)
- [Usage logs](providers/codex/usage-logs.md)
- [Archiving](providers/codex/archiving.md)

### Cursor

- [Overview](providers/cursor/overview.md)
- [Agent bundles](providers/cursor/agent-bundles.md)
- [Usage logs](providers/cursor/usage-logs.md)
- [Archiving](providers/cursor/archiving.md)

### Antigravity

- [Overview](providers/antigravity/overview.md)
- [Agent bundles](providers/antigravity/agent-bundles.md)
- [Usage logs](providers/antigravity/usage-logs.md)
- [Archiving](providers/antigravity/archiving.md)

### Gemini CLI

- [Overview](providers/gemini-cli/overview.md)
- [Agent bundles](providers/gemini-cli/agent-bundles.md)
- [Usage logs](providers/gemini-cli/usage-logs.md)
- [Archiving](providers/gemini-cli/archiving.md)

### OpenCode

- [Overview](providers/opencode/overview.md)
- [Agent bundles](providers/opencode/agent-bundles.md)
- [Usage logs](providers/opencode/usage-logs.md)
- [Archiving](providers/opencode/archiving.md)

## Plugins

Cairn's own toolsets, shipped as installable agent bundles. Each page lists every skill,
subagent, hook, MCP server, asset, and contract test.

- [Overview](plugins.md)
- [cairn-markdown](plugins/cairn-markdown.md)
- [cairn-scripts](plugins/cairn-scripts.md)
- [cairn-usage](plugins/cairn-usage.md)
- [cairn-archive](plugins/cairn-archive.md)
- [cairn-agent](plugins/cairn-agent.md)

## Contract commands

- [`describe`](commands/describe.md)
- [`schema`](commands/schema.md)

## Agent commands

- [`agent init`](commands/agent/init.md)
- [`agent add`](commands/agent/add.md)
- [`agent import`](commands/agent/import.md)
- [`agent convert`](commands/agent/convert.md)
- [`agent upgrade`](commands/agent/upgrade.md)
- [`agent validate`](commands/agent/validate.md)
- [`agent inspect`](commands/agent/inspect.md)
- [`agent compat`](commands/agent/compat.md)
- [`agent package`](commands/agent/package.md)
- [`agent marketplace`](commands/agent/marketplace.md)
- [`agent install`](commands/agent/install.md)
- [`agent uninstall`](commands/agent/uninstall.md)
- [`agent installed`](commands/agent/installed.md)
- [`agent audit`](commands/agent/audit.md)
- [`agent test`](commands/agent/test.md)
- [`agent doctor`](commands/agent/doctor.md)
- [`agent verify`](commands/agent/verify.md)
- [`agent specs`](commands/agent/specs.md)

## Script commands

- [`scripts run`](commands/scripts/run.md)
- [`scripts which`](commands/scripts/which.md)
- [`scripts list`](commands/scripts/list.md)

## Usage commands

- [`usage summary`](commands/usage/summary.md)
- [`usage tokens`](commands/usage/tokens.md)
- [`usage tools`](commands/usage/tools.md)
- [`usage sessions`](commands/usage/sessions.md)
- [`usage projects`](commands/usage/projects.md)
- [`usage skills`](commands/usage/skills.md)
- [`usage agents`](commands/usage/agents.md)
- [`usage hooks`](commands/usage/hooks.md)
- [`usage commands`](commands/usage/commands.md)
- [`usage providers`](commands/usage/providers.md)
- [`usage index`](commands/usage/index.md)
- [`usage import`](commands/usage/import.md)
- [`usage migrate`](commands/usage/migrate.md)

## Archive commands

- [`archive run`](commands/archive/run.md)
- [`archive status`](commands/archive/status.md)
- [`archive list`](commands/archive/list.md)
- [`archive extract`](commands/archive/extract.md)
- [`archive verify`](commands/archive/verify.md)
- [`archive migrate`](commands/archive/migrate.md)

## Other top-level commands

- [`check-update`](commands/check-update.md)
- [`completion`](commands/completion.md)
- [`serve`](commands/serve.md)

## Markdown validation commands

- [`md lint`](commands/md/lint.md)
- [`md lint-dir`](commands/md/lint-dir.md)
- [`md check-urls`](commands/md/check-urls.md)
- [`md check-snippets`](commands/md/check-snippets.md)
- [`md validate-frontmatter`](commands/md/validate-frontmatter.md)
- [`md audit`](commands/md/audit.md)

## Markdown reference and workspace commands

- [`md refs`](commands/md/refs.md)
- [`md refs-to`](commands/md/refs-to.md)
- [`md links`](commands/md/links.md)
- [`md orphans`](commands/md/orphans.md)
- [`md graph`](commands/md/graph.md)
- [`md query`](commands/md/query.md)
- [`md index`](commands/md/index.md)

## Markdown analysis commands

- [`md headers`](commands/md/headers.md)
- [`md outline`](commands/md/outline.md)
- [`md toc`](commands/md/toc.md)
- [`md stats`](commands/md/stats.md)
- [`md code-blocks`](commands/md/code-blocks.md)
- [`md structure`](commands/md/structure.md)
- [`md section`](commands/md/section.md)
- [`md frontmatter`](commands/md/frontmatter.md)
- [`md tasks`](commands/md/tasks.md)
- [`md tables`](commands/md/tables.md)
- [`md context`](commands/md/context.md)
- [`md diff`](commands/md/diff.md)

## Markdown modification commands

- [`md fix`](commands/md/fix.md)
- [`md rename-heading`](commands/md/rename-heading.md)
- [`md rename-file`](commands/md/rename-file.md)
