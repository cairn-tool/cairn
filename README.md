# Cairn

[![OpenSSF Scorecard](https://api.securityscorecards.dev/projects/github.com/cairn-tool/cairn/badge)](https://scorecard.dev/viewer/?uri=github.com/cairn-tool/cairn)

An agent-agnostic CLI toolkit for working with Markdown files and related assets. Cairn
supports all LLM coding agents, as well as humans and CI systems; its commands do not
depend on Claude or any model-provider API.

Published as [`@cairn-tool/cairn`](https://www.npmjs.com/package/@cairn-tool/cairn) on the
public npm registry; the installed binary is named `cairn`.

> **Renamed from `claude-cli`.** The old name implied a coupling that never existed. Every
> identifier Cairn writes into your files or environment is still _read_ under its pre-rename
> spelling, so nothing on disk has to change — see
> [Migrating from claude-cli](docs/migration.md).

## Install

No registry configuration and no token — the package is public.

```bash
npm install -g @cairn-tool/cairn
cairn --version
```

Or without installing: `npx @cairn-tool/cairn md lint README.md`.

Releases are published through OIDC trusted publishing, so every version carries a provenance
attestation. Node 22.22.2+, 24.15.0+, or 26+ is required.
[Installation details](docs/install.md) covers keeping a stable path across Node upgrades and
building from source.

## Quick start

```bash
# Markdown: check a docs tree, then fix what is mechanical.
cairn md lint-dir docs --style
cairn md fix docs --write

# Find what points at a file before you move it, then move it.
cairn md refs-to docs/setup.md
cairn md rename-file docs/setup.md docs/getting-started.md

# Agent bundles: write once, render for every host.
cairn agent convert ./my-bundle --target all --output ./dist
cairn agent verify                      # has the committed tree drifted?

# Named scripts: same result from any directory in the repo.
cairn scripts run lint-changed -- --fix

# Where did the tokens go?
cairn usage summary
```

Every command takes `--format llm|human|json` (`-fh`/`-fj` for short) and exits `0` when clean,
`1` on a usage error, and **`2` when it found something** — exit `2` is the answer, not a
failure to retry. The [complete command listing](docs/commands.md) has all of them.

## What is in it

Six toolsets, plus `describe`, `schema`, `serve`, `completion`, and `check-update`.

| Toolset   | Does                                                                      | Guide                                        |
| --------- | ------------------------------------------------------------------------- | -------------------------------------------- |
| `md`      | Lint, validate, query, and safely refactor a Markdown workspace.          | [Markdown](docs/guide/markdown.md)           |
| `agent`   | Compile one portable bundle into every assistant's native format.         | [Agent bundles](docs/guide/agent-bundles.md) |
| `scripts` | Resolve and run a repository's named commands from anywhere inside it.    | [Named scripts](docs/guide/scripts.md)       |
| `usage`   | Report on local assistant transcripts: tokens, tools, sessions, and cost. | [Usage reporting](docs/guide/usage.md)       |
| `archive` | Keep what a session produced before the logs are pruned, and get it back. | [Archiving](docs/guide/archiving.md)         |
| `jira`    | Convert Jira and Confluence rich text between ADF and Markdown.           | [Jira rich text](docs/guide/jira.md)         |

Nothing calls a model, and nothing sends anything anywhere. `scripts run` is the only command
that executes anything, and only what a tracked file in your repository names.

## Documentation

Full documentation lives in
[`docs/`](https://github.com/cairn-tool/cairn/tree/main/docs).

| Page                                                 | Covers                                                 |
| ---------------------------------------------------- | ------------------------------------------------------ |
| [Documentation contents](docs/_contents.md)          | Index of everything below.                             |
| [Complete command listing](docs/commands.md)         | Every command, with a one-line description.            |
| [Guides](docs/guide.md)                              | Why each toolset exists.                               |
| [Project configuration](docs/configuration.md)       | The `.cairn.yml` schema.                               |
| [Machine-readable result contract](docs/contract.md) | JSON output, the envelope, and what may change.        |
| [File formats and schemas](docs/formats.md)          | The files Cairn itself reads and writes.               |
| [Diagnostic codes](docs/formats/diagnostic-codes.md) | Every `AB###` and `AD###`, with severity and meaning.  |
| [Providers](docs/providers.md)                       | What is known about each assistant's own formats.      |
| [Cairn's own plugins](docs/plugins.md)               | The six toolsets, shipped as agent bundles.            |
| [Installing Cairn](docs/install.md)                  | Node versions, stable paths, and building from source. |
| [Migrating from claude-cli](docs/migration.md)       | Every pre-rename identifier, and what still reads it.  |

## Claude Code plugins

Cairn ships its own toolsets as installable plugins, so an assistant has the command surface
available without rediscovering it from `--help`:

```text
/plugin marketplace add cairn-tool/cairn@claude-plugins
/plugin install cairn-markdown@cairn
```

They are authored as agent bundles under `plugins/`, built with the same `agent` commands they
document. **The `cairn` binary is a separate install** — the plugins invoke it, they do not
carry it. See [Cairn's own plugins](docs/plugins.md) for what each one contains.

## Contributing

Pull requests are welcome. [CONTRIBUTING.md](CONTRIBUTING.md) covers the setup, the
pre-push checks, the Conventional Commits requirement, and the handful of conventions that
are load-bearing rather than stylistic.

## Security

Report a vulnerability privately through GitHub Security Advisories rather than in a public
issue. [SECURITY.md](SECURITY.md) lists what is in scope — chiefly `scripts run`, the only
command that executes anything.

## License

MIT — see [LICENSE](LICENSE).
