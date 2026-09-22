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
| `--register`          | Off      | Activate a marketplace through the host's declared integration.                    |
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
every target. Expanding to all five would make `--target all --scope user` hard-fail on
`opencode` — and a hard fail writes nothing at all, see below. An explicitly named target
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
| `register` | `false`   | Activate a marketplace through the host integration.            |
| `bundles`  | Required  | One entry per bundle: `path`, and one of `include` / `exclude`. |

The full key schema is in [project configuration](../../configuration.md#agentinstall).

`cairn agent install --config cairn-verify.yml` installs the cross product, minus each bundle's
own `include`/`exclude`. A flag on the command line overrides the block, except `--target`,
which **narrows** it and may not name a target the block does not declare — the same rule
[`agent marketplace`](marketplace.md#--target-narrows-never-widens) uses, and for the same
reason: a flag that could add a target would let CI install for a host the repository never
declared.

## Destinations

| Target        | Scope   | Root                                    | Layout        | Profile | Activation                |
| ------------- | ------- | --------------------------------------- | ------------- | ------- | ------------------------- |
| `cursor`      | `user`  | `~/.cursor/plugins/local/<name>`        | `plugin-dir`  | plugin  | Auto-scanned              |
| `cursor`      | project | `.`                                     | `merge`       | project | None                      |
| `claude-code` | `user`  | `~/.claude/plugins/marketplaces/<name>` | `marketplace` | plugin  | `~/.claude/settings.json` |
| `claude-code` | project | `.`                                     | `merge`       | project | None                      |
| `codex`       | `user`  | `$CODEX_HOME/marketplaces/<name>`       | `marketplace` | plugin  | `codex plugin` CLI        |
| `codex`       | project | `.`                                     | `merge`       | project | None                      |

`--into` replaces the **root**, not the final plugin directory: a plugin-dir or marketplace
install still lands at `<into>/<name>`. A merge install writes into `<into>` itself.

## Copy and `--link`

Copy is the default. `--link` still materializes the rendered tree once, into
`<bundle>/.install/<target>/<profile>/`, because a bundle source tree is not a valid plugin
tree. The host-side path is then a symlink to that materialized tree. Edits to the
materialized files are live (`AB807`); the host may not follow the symlink.

## `--register`

`--register` is the only flag that changes host activation state, and only the `marketplace`
layout needs it. Claude Code adds `extraKnownMarketplaces` and `enabledPlugins` to
`~/.claude/settings.json`. Codex runs `codex plugin marketplace add <destination> --json`, then
`codex plugin add <plugin>@<marketplace> --json` for every installed plugin. Without
`--register`, the marketplace is still written and the exact edit or commands are reported as
`AB805`.

Codex user installs prefer `$CODEX_HOME/marketplaces`; when `CODEX_HOME` is unset the root is
`~/.codex/marketplaces`. Registration refuses to take over a same-named Codex marketplace that
points somewhere else, even with `--force`. `--check` verifies the marketplace root plus each
plugin's installed, enabled, and version state.

Registering is necessary but not sufficient: Claude Code validates the catalog those keys point
at and, if it fails, drops the marketplace **and** prunes the settings entries — so a bad catalog
looks like a `--register` that never ran. `marketplace.publisher` is therefore required in the
bundle, since the catalog's `owner` comes from it; see
[`agent package`](package.md#claude-code-requires-a-marketplace-owner). Verify an install
with `claude plugin validate ~/.claude/plugins/marketplaces/<name>`.

## Installed-state manifest

Each destination gets `.cairn-install.json`: generator name and version, bundle name and
version, target, profile, scope, layout, mode (`copy`/`link`), the bundle root relative to the
destination, and a path/mode/sha256 inventory. [`agent uninstall`](uninstall.md) removes
exactly that inventory. [`agent installed`](installed.md) lists what it finds, the edit
guard's own records included.

A prior install with the same `(bundle, target, profile, scope)` is replaced and reported as
`AB802`. A path that exists and no record accounts for is `AB801` unless `--force` is given. A
destination is **not** occupied merely because a different bundle is recorded there.

## The edit guard

A project-scope install also writes **`.cairn-guard.sh`** at the destination root, beside the
manifest, and registers it as a `pre-tool-use` hook in each host's project-level hook
document — `.claude/settings.json` for Claude Code, `.cursor/hooks.json` for Cursor. Before
every write the assistant makes, the host runs it; it refuses an edit to a file this install
wrote and names the bundle source to edit instead:

```text
Refusing to edit a cairn-generated file.

  .claude/skills/bundle-authoring/SKILL.md
  is generated by cairn from bundle 'cairn-agent'.

Edit the source instead:
  plugins/cairn-agent/skills/bundle-authoring/SKILL.md

Then regenerate:
  cairn agent install
```

The script is POSIX `sh` with the install inventory baked in as a `case` over exact paths.
It runs no other program on the allow path and takes a few milliseconds, which is the point:
its predecessor was a global plugin hook that started Node twice on every edit in every
repository, whether or not that repository had anything to guard. This one exists only where
an install put it, and lists only what that install wrote.

- The hook document is **merged into, never replaced**. A `.claude/settings.json` the
  repository already has keeps its `permissions` and its own hooks; the guard's handler is
  added once, and later installs replace it in place. The document is not itself guarded
  unless a bundle's `policies` rendered it.
- The guard is **on by default** for every project-scope install. `agent.guard.mode: off` in
  the configuration turns it off; `mode: warn` reports without blocking; `agent.guard.allow`
  exempts paths; `agent.guard.regenerate` sets the command the message quotes, which defaults
  to the fixed string `cairn agent install`. See [`agent.guard`](../../configuration.md#agentguard).
- Every byte of the script derives from the manifest and the configuration — no timestamp,
  no invocation, no absolute path — so [`agent verify`](verify.md) regenerates it and compares.
  A bundle that gains a file makes the guard stale, which `--check` reports.
- A target with no project hook surface (Codex, Antigravity, OpenCode) gets no registration
  and one `AB810` notice; its files are still in the list, and the host that does invoke the
  guard refuses edits to them too.
- The guard has its own manifest records, `kind: "guard"` named `.cairn-guard`, rebuilt on
  every run. They are not a bundle: `agent uninstall .cairn-guard` is refused (`AB813`), the
  guard follows the last bundle out, and a settings document cairn created goes with it while
  one it merged into is only stripped of the handler.

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
| `AB805` | warning  | Host activation is required but `--register` was not given.                                     |
| `AB806` | error    | Install manifest missing or malformed.                                                          |
| `AB807` | notice   | `--link` in use; edits are live and the host may not follow symlinks.                           |
| `AB808` | error    | A path is claimed by two installs at one destination.                                           |
| `AB809` | error    | A `--link` install cannot share a destination with another install.                             |
| `AB810` | notice   | The target declares no project hook surface, so the edit guard is not registered for it.        |
| `AB811` | error    | The host's project hook document is not a JSON object; the guard cannot be merged into it.      |
| `AB812` | warning  | A generated path carries a control character and is left out of the guard.                      |

## Examples

```bash
# Cursor user plugin, auto-scanned.
cairn agent install ./bundle --target cursor --scope user

# Claude Code local marketplace, and edit settings.json to enable it.
cairn agent install ./bundle --target claude-code --scope user --register

# Codex local marketplace, installed and enabled through the native CLI.
cairn agent install ./bundle --target codex --scope user --register

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
