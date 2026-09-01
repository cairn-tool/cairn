# Local install scripts

One script per host, for putting the bundles under [`plugins/`](../plugins) onto your own
machine without publishing anything. Each is a thin wrapper over
[`cairn agent install`](../docs/commands/agent/install.md) — the destinations come from the
target profiles, not from these scripts.

| Script                   | Host        | Default destination                    |
| ------------------------ | ----------- | -------------------------------------- |
| `install-claude-code.sh` | Claude Code | `~/.claude/plugins/marketplaces/cairn` |
| `install-cursor.sh`      | Cursor      | `~/.cursor/plugins/local/<name>`       |
| `install-antigravity.sh` | Antigravity | `~/.gemini/config/plugins/<name>`      |
| `install-codex.sh`       | Codex       | the current directory (project scope)  |
| `install-opencode.sh`    | OpenCode    | the current directory (project scope)  |

```bash
scripts/install-claude-code.sh              # all six bundles, one marketplace, activated
scripts/install-cursor.sh --dry-run         # plan it without writing
scripts/install-codex.sh --into ~/src/app   # into another repository
scripts/install-antigravity.sh cairn-usage  # one bundle
scripts/install-opencode.sh --uninstall     # undo
```

`--help` on any of them lists the full flag set.

## What each one does differently

**Claude Code** installs the whole collection as a _single_ marketplace, via
[`agent marketplace --install --register`](../docs/commands/agent/marketplace.md), because that
is what `/plugin` lists and what one `enabledPlugins` block activates. `--no-register` writes it
without editing `~/.claude/settings.json`; the exact edit is then reported as `AB805`. Naming
bundles falls back to a per-bundle install, and each of those becomes a marketplace of its own.

**Cursor** and **Antigravity** get a `plugin-dir` install per bundle. Both hosts scan their
plugin directory, so there is nothing to register — restart the host.

**Codex** and **OpenCode** have no user-scope destination, and the scripts refuse `--scope user`
rather than writing somewhere the host does not read. Codex's user-scope rules root is
`~/AGENTS.md`, which an install would clobber; OpenCode's global layout drops the `.opencode/`
prefix, which an install root override cannot express. Both install into a project directory
instead — the current one, or `--into <dir>`.

## Which cairn runs

This checkout's own build, `dist/cli.js` — the bundles here are this checkout's, and a globally
installed `cairn` may predate a manifest key they use. A missing `node_modules` or `dist/` is
installed and built first.

| Variable           | Effect                                               |
| ------------------ | ---------------------------------------------------- |
| `CAIRN_BIN`        | Use this invocation instead, e.g. `CAIRN_BIN=cairn`. |
| `CAIRN_NO_BUILD=1` | Never build; fall back to `cairn` on `PATH`.         |
| `NO_COLOR`         | Plain output.                                        |

## Undoing an install

`--uninstall` on the same script, with the same `--into` and `--scope`. It removes exactly the
inventory recorded in the destination's `.cairn-install.json` and nothing else, so a hand-edited
file next to it survives. [`cairn agent installed`](../docs/commands/agent/installed.md) lists
what is currently in place.

## Approximate diagnostics are expected

Every host except Claude Code loses something in translation — a skill invocation policy that is
advisory rather than enforced, tool restrictions that need a per-target override. Those are
`approximate` warnings and do not fail an install. `--strict` makes them fail, which is what CI
does.

## Checking every target

`check-bundles.sh` is the check `ci.yml` runs, and it runs locally unchanged:

```bash
scripts/check-bundles.sh                      # 5 targets x 6 bundles x 5 commands
scripts/check-bundles.sh cursor opencode      # just those hosts
scripts/check-bundles.sh --bundle cairn-jira  # one bundle, every host
scripts/check-bundles.sh --strict             # require zero findings everywhere
```

It cannot gate on the exit code, and that is the whole reason it exists.
`agent validate` and `agent convert` route through `hasFindings`, which fails on any
`approximate` diagnostic — so only `claude-code`, which renders these bundles with no findings
at all, can be held to an exit-0 bar. The other four inherently carry warnings that are
properties of the host:

| Code    | Quality     | What it reports                              |
| ------- | ----------- | -------------------------------------------- |
| `AB302` | approximate | no portable `${ARGUMENTS}` substitution      |
| `AB310` | approximate | skill invocation policy is advisory          |
| `AB332` | approximate | tool restrictions need a per-target override |
| `AB340` | unsupported | no custom agents in the plugin profile       |
| `AB370` | unsupported | project MCP requires TOML                    |

So those four are gated on `error` diagnostics instead, and the warning count per host is
printed as a tally — currently 120 for Antigravity, 73 for Codex, 57 each for Cursor and
OpenCode, 0 for Claude Code. An invocation or I/O error (exit 1) fails on every target.

`agent test`'s cases are declared for `claude-code`, so on the other four hosts they report
`AB720` skipped rather than asserting anything. The render is checked there; the bundle contract
tests are not.

## Not for CI

CI installs from [`cairn-verify.yml`](../cairn-verify.yml) — the declared block that says what
this repository installs into itself — with `cairn agent install --config cairn-verify.yml`.
These scripts are for a developer's machine, where the destination is a host directory rather
than the repository.
