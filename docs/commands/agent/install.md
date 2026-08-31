# `agent install`

## Synopsis

```text
cairn agent install <source> --target <target> [options]
cairn agent install --config <file> [options]
```

Places a bundle where a host actually scans for plugins or project files. Rendering and
packaging happen in memory — the same way [`agent package`](package.md) does — so an
install is always derived from the bundle rather than from a possibly-drifted `dist/` tree.

Destinations are **profile data**, not command logic. `agent specs --format json` publishes
the `install` block each target declares; this command reads that block rather than branching
on the target name.

**Stability: experimental.** The payload shape may change before it hardens.

## Arguments

| Argument | Required | Description                              |
| -------- | -------- | ---------------------------------------- |
| `source` | No       | Bundle root. Omit when using `--config`. |

Exactly one of `source` and `--config` is required.

## Options

| Option                | Default  | Description                                                                        |
| --------------------- | -------- | ---------------------------------------------------------------------------------- |
| `--target <target>`   | Required | Repeatable: `claude-code`, `codex`, `cursor`, `antigravity`, `opencode`, or `all`. |
| `--config <file>`     | —        | Install the `agent.install` block a config file declares.                          |
| `--name <name>`       | all      | With `--config`, install only the named bundle. Repeatable.                        |
| `--scope <scope>`     | `user`   | `user` or `project`. With `--config`, defaults to the block.                       |
| `--into <dir>`        | Profile  | Override the install root the profile declares.                                    |
| `--profile <profile>` | Location | Must match the location's profile when given.                                      |
| `--link`              | Off      | Symlink the rendered tree instead of copying it.                                   |
| `--register`          | Off      | Edit host config to activate a marketplace install.                                |
| `--strict`            | Off      | Treat warnings as blocking findings.                                               |
| `--force`             | Off      | Replace a destination that is not a prior install of this bundle.                  |
| `--dry-run`           | Off      | Plan the install without writing.                                                  |
| `--check`             | Off      | Compare against an existing install without writing.                               |
| `--format <fmt>`      | `llm`    | Output as `llm`, `human`, or `json`. Shorthands: `-fh`, `-fj`.                     |
| `--envelope`          | Off      | Wrap `--format json` output in the versioned result envelope.                      |
| `-h`, `--help`        | —        | Show help.                                                                         |

`--check` and `--dry-run` cannot be combined. `--profile` applies to a single `--target`,
because install uses one profile per destination.

`--target all` expands to every target that declares a location for the requested scope, not to
every target. Expanding to all five would make `--target all --scope user` hard-fail on `codex`
and `opencode` — and a hard fail writes nothing at all, see below. An explicitly named target
with no location still reports `AB800`.

## Several installs in one run

`--target` is repeatable, and every target's project scope resolves to the same merge root, so
one destination may hold several installs. They are told apart by
`(bundle, target, profile, scope)`, recorded that way in the
[install manifest](../../formats/install-manifest.md#several-installs-at-one-destination), and
reinstalling one prunes only its own stale files.

```bash
cairn agent install ./bundle --target claude-code --target codex --scope project --into .
```

**A run is planned in full before anything is written.** If any plan is blocked, nothing is
written for any of them — committing the clean part of a run is how a destination ends up
half-populated with no record of it.

Two installs writing byte-identical content to one path is co-ownership; writing different
content there is `AB808`.

## Installing a declared block

A repository can declare what it installs into itself, in the `agent:` block of `.cairn.yml` —
the same file [`agent verify`](verify.md) reads, found by the same walk:

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

| Key        | Default   | Meaning                                                         |
| ---------- | --------- | --------------------------------------------------------------- |
| `targets`  | Required  | Targets every bundle is installed for.                          |
| `scope`    | `project` | `user` or `project`.                                            |
| `into`     | Profile   | Install root override; must not escape the config directory.    |
| `link`     | `false`   | Symlink the rendered trees.                                     |
| `register` | `false`   | Edit host config to activate a marketplace install.             |
| `bundles`  | Required  | One entry per bundle: `path`, and one of `include` / `exclude`. |

The full key schema is in [project configuration](../../configuration.md#agentinstall).

`cairn agent install --config cairn-verify.yml` installs the cross product, minus each bundle's
own `include`/`exclude`. A flag on the command line overrides the block, except `--target`,
which **narrows** it and may not name a target the block does not declare — the same rule
[`agent marketplace`](marketplace.md#--target-narrows-never-widens) uses, and for the same
reason: a flag that could add a target would let CI install for a host the repository never
declared.

## Destinations

| Target        | Scope   | Root                                    | Layout        | Profile | Activation                           |
| ------------- | ------- | --------------------------------------- | ------------- | ------- | ------------------------------------ |
| `cursor`      | `user`  | `~/.cursor/plugins/local/<name>`        | `plugin-dir`  | plugin  | Auto-scanned                         |
| `cursor`      | project | `.`                                     | `merge`       | project | None                                 |
| `claude-code` | `user`  | `~/.claude/plugins/marketplaces/<name>` | `marketplace` | plugin  | `~/.claude/settings.json`            |
| `claude-code` | project | `.`                                     | `merge`       | project | None                                 |
| `codex`       | `user`  | —                                       | —             | —       | `AB800`; would clobber `~/AGENTS.md` |
| `codex`       | project | `.`                                     | `merge`       | project | None                                 |

`--into` replaces the **root**, not the final plugin directory: a plugin-dir or marketplace
install still lands at `<into>/<name>`. A merge install writes into `<into>` itself.

## Copy and `--link`

Copy is the default. `--link` still materializes the rendered tree once, into
`<bundle>/.install/<target>/<profile>/`, because a bundle source tree is not a valid plugin
tree. The host-side path is then a symlink to that materialized tree. Edits to the
materialized files are live (`AB807`); the host may not follow the symlink.

## `--register`

`--register` is the only flag that edits host config, and only the `marketplace` layout needs
it. It adds `extraKnownMarketplaces` and `enabledPlugins` to `~/.claude/settings.json`. Without
it, the marketplace is still written and the exact edit is reported as `AB805`.

Registering is necessary but not sufficient: Claude Code validates the catalog those keys point
at and, if it fails, drops the marketplace **and** prunes the settings entries — so a bad catalog
looks like a `--register` that never ran. `marketplace.publisher` is therefore required in the
bundle, since the catalog's `owner` comes from it; see
[`agent package`](package.md#claude-code-requires-a-marketplace-owner). Verify an install
with `claude plugin validate ~/.claude/plugins/marketplaces/<name>`.

## Installed-state manifest

Each destination gets `.cairn-install.json`: generator name and version, bundle name and
version, target, profile, scope, layout, mode (`copy`/`link`), and a path/mode/sha256
inventory. [`agent uninstall`](uninstall.md) removes exactly that inventory.
[`agent installed`](installed.md) lists what it finds.

A prior install with the same `(bundle, target, profile, scope)` is replaced and reported as
`AB802`. A path that exists and no record accounts for is `AB801` unless `--force` is given. A
destination is **not** occupied merely because a different bundle is recorded there.

## Diagnostics

Approximate render diagnostics alone do **not** fail install — a Codex bundle inherently
carries them. Only errors, and warnings under `--strict`, fail.

| Code    | Severity | Meaning                                                                                         |
| ------- | -------- | ----------------------------------------------------------------------------------------------- |
| `AB800` | error    | No recorded install location for this target and scope.                                         |
| `AB801` | error    | Destination occupied by something that is not a prior install of this bundle.                   |
| `AB802` | notice   | Replacing an existing install of this bundle (reports the version delta).                       |
| `AB803` | warning  | A bundle feature does not render in the installed profile (for example hooks at project scope). |
| `AB804` | error    | A destination path escapes the resolved scope root.                                             |
| `AB805` | warning  | Host activation edit required but `--register` was not given.                                   |
| `AB807` | notice   | `--link` in use; edits are live and the host may not follow symlinks.                           |

## Examples

```bash
# Cursor user plugin, auto-scanned.
cairn agent install ./bundle --target cursor --scope user

# Claude Code local marketplace, and edit settings.json to enable it.
cairn agent install ./bundle --target claude-code --scope user --register

# Project-scope merge into a named directory, preview only.
cairn agent install ./bundle --target cursor --scope project --into ./app --dry-run

# Both hosts into a repository, in one run.
cairn agent install ./bundle --target claude-code --target codex --scope project --into .

# Everything the repository declares.
cairn agent install --config cairn-verify.yml

# Live edits while iterating on a plugin.
cairn agent install ./bundle --target cursor --scope user --link
```

## Exit codes

| Code | Meaning                                    |
| ---- | ------------------------------------------ |
| `0`  | Installed, or checks passed.               |
| `1`  | Invocation, path, or I/O error.            |
| `2`  | Install finding, or `--check` found drift. |
