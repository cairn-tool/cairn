# Migrating from claude-cli

Cairn was named `claude-cli` through v1.11.0. The rename changes what Cairn _writes_, never
what it _reads_: every identifier the old name put into your files, your repositories, or
your environment is still accepted, so nothing on disk has to be touched.

| What                          | Cairn writes                        | Still read                      |
| ----------------------------- | ----------------------------------- | ------------------------------- |
| Config file                   | `.cairn.yml`                        | `.claude-cli.yml`               |
| TOC markers                   | `<!-- cairn:toc:start -->` / `:end` | `<!-- claude-cli:toc:… -->`     |
| Snippet attribute             | `cairn:snippet=`                    | `claude-cli:snippet=`           |
| Snippet region markers        | `cairn:snippet:start NAME`          | `claude-cli:snippet:start NAME` |
| Agent install manifest        | `.cairn-install.json`               | `.claude-cli-install.json`      |
| `md audit` baseline           | `cairn-md-audit-baseline`           | `claude-cli-md-audit-baseline`  |
| Package inventory `bomFormat` | `cairn-inventory`                   | `claude-cli-inventory`          |
| Update-notice opt-out         | `CAIRN_NO_UPDATE_NOTIFIER`          | `CLAUDE_CLI_NO_UPDATE_NOTIFIER` |

A document already carrying `claude-cli:toc` markers keeps them: `md toc --write` rewrites
only the list between the markers, so a legacy document that is already current stays
current rather than reporting drift for a cosmetic change. The same holds for a fence's
`claude-cli:snippet=` attribute, which `md check-snippets --write` never rewrites. Migrate a
file by editing the marker yourself, or leave it — both spellings are equal indefinitely.

`scripts run` exports every variable under both spellings, so a script reading
`CLAUDE_CLI_SCRIPT_ROOT` needs no change:

```text
CAIRN_SCRIPT_NAME       CLAUDE_CLI_SCRIPT_NAME
CAIRN_SCRIPT_ROOT       CLAUDE_CLI_SCRIPT_ROOT
CAIRN_SCRIPT_REGISTRY   CLAUDE_CLI_SCRIPT_REGISTRY
CAIRN_SCRIPT_DEPTH      CLAUDE_CLI_SCRIPT_DEPTH
CAIRN_SCRIPT_STACK      CLAUDE_CLI_SCRIPT_STACK
CAIRN_INVOKED_FROM      CLAUDE_CLI_INVOKED_FROM
```

What **does** change for consumers: the binary is `cairn`, the package is
`@cairn-tool/cairn` on the public npm registry, the envelope's `tool.name` reports it,
schema `$id`s are rooted at `https://github.com/cairn-tool/cairn/schema`, and the contract
`schemaVersion` is `3`. Regenerate your shell completion script after upgrading, and
re-point anything holding an absolute path to the old binary.

> **Also moved registries.** v1.11.0 shipped as `@bstockus/cairn` on GitHub Packages, which
> required a token even though the repository was public. That name is not updated any
> further — uninstall it (`npm uninstall -g @bstockus/cairn`) and install
> `@cairn-tool/cairn`, which needs no credentials at all.

## Related

- [Machine-readable result contract](contract.md) — the envelope, the schemas, and the contract version.
- [Markdown conventions](formats/markdown-conventions.md) — the TOC and snippet markers, in both spellings.
- [Install manifest](formats/install-manifest.md) — which records the legacy name too.
