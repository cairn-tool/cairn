# `agent guard`

## Synopsis

```text
cairn agent guard <file> [options]
```

Reports whether a path is content cairn generated, and if so which bundle file produces it.

A repository that renders its agent content with [`agent install`](install.md) or
[`agent convert`](convert.md) ends up with a tree of `.claude/`, `.codex/`, `.cursor/` and
`.agents/` files that are **build output**. They look like ordinary editable Markdown and
JSON, so an assistant edits one, and the next render destroys the change without a word. This
command is the check that catches that, and the `cairn-agent` bundle ships a `pre-tool-use`
hook that calls it before every write.

It writes nothing, ever, and renders nothing: the path is matched against the target
profile's own declared output patterns and confirmed against the bundle that sources the
component the pattern names.

## Options

| Option            | Default    | Description                                                    |
| ----------------- | ---------- | -------------------------------------------------------------- |
| `--config <file>` | Discovered | Configuration document declaring the `agent.guard` block.      |
| `--format <fmt>`  | `llm`      | Output as `llm`, `human`, or `json`. Shorthands: `-fh`, `-fj`. |
| `--envelope`      | Off        | Wrap `--format json` output in the versioned result envelope.  |
| `-h`, `--help`    | —          | Show help.                                                     |

Without `--config`, discovery walks upward **from the directory holding `<file>`** — not from
the working directory, because a hook runs wherever the host happened to start — and stops at
the nearest `.cairn.yml` (or the legacy `.claude-cli.yml`) that declares an `agent.guard`
block. `node_modules` is skipped, so a vendored configuration cannot win by being nearest.

A repository that declares no block is **not guarded**, and the command exits `0` saying so.
That is what makes the hook safe to install once, globally, for every repository.

## Configuration

The block is documented in full under
[project configuration](../../configuration.md#agentguard).

```yaml
version: 1
agent:
  install:
    targets: [claude-code, codex, cursor]
    scope: project
    into: .
    bundles:
      - path: plugins/cairn-markdown
  guard:
    mode: block
    regenerate: "cairn agent install"
```

Entries are derived from `agent.install` unless `agent.guard.entries` declares its own, so the
common case restates nothing. Only project-scope install locations are derived.

## How a path is judged

A path is generated when **both** hold:

1. it lies under a configured destination and matches one of that target and profile's
   declared output patterns — `.claude/skills/{name}/**`, `.codex/agents/{name}.toml`,
   `.mcp.json`, and the rest, exactly as
   [the target profile](../../formats/target-profile.md) declares them; and
2. a configured bundle actually holds the component the pattern's `{name}` identifies.

The second test is not redundant. It is the same lookup that produces the "edit this instead"
pointer, and it is what keeps a hand-written `.claude/agents/scratch.md` sitting beside
generated ones from being refused. A path that passes the first test and fails the second is
`unowned`, and `agent.guard.unowned` decides whether that blocks.

The reverse mapping follows the bundle's own layout, `components:` overrides included, because
an output pattern's feature key and a manifest's component key are the same vocabulary:

| Rendered                              | Feature  | Source                        |
| ------------------------------------- | -------- | ----------------------------- |
| `.claude/skills/greet/SKILL.md`       | `skills` | `skills/greet/SKILL.md`       |
| `.claude/skills/greet/reference/a.md` | `skills` | `skills/greet/reference/a.md` |
| `.claude/agents/reviewer.md`          | `agents` | `agents/reviewer.agent.md`    |
| `.claude/rules/style.md`              | `rules`  | `rules/style.md`              |
| `hooks/hooks.json`                    | `hooks`  | `hooks/hooks.yaml`            |
| `.mcp.json`                           | `mcp`    | `mcp/mcp.yaml`                |
| `assets/logo.svg`                     | `assets` | `assets/logo.svg`             |

A component whose frontmatter `name:` disagrees with its directory is still found: the
conventional path is tried first, and a frontmatter scan is the fallback.

A rendered file that merges several bundles — `.mcp.json`, `.claude/settings.json`, Codex's
`AGENTS.md` — names every bundle that contributes to it and no single owning bundle, because
there is not one.

## Exit codes

| Condition                                                         | Code | Stream |
| ----------------------------------------------------------------- | ---- | ------ |
| The path may be edited, the guard warns, or nothing is configured | `0`  | stdout |
| Invocation, configuration, or I/O error                           | `1`  | stdout |
| The path is cairn-generated and `mode: block`                     | `2`  | stdout |

Every agent subcommand puts its findings on stdout, and this one is no exception.

**Every outcome that is not a refusal exits `0`** — a missing configuration, a path outside
every destination, an unreadable bundle manifest. A guard that failed closed would block
editing on any repository whose configuration has a typo, which is a worse failure than the
one it prevents.

## Examples

```bash
# Judge one path.
cairn agent guard .claude/skills/bundle-authoring/SKILL.md

# The machine-readable verdict the hook reads.
cairn agent guard .claude/agents/reviewer.md -fj
```

```text
Refusing to edit a cairn-generated file.

  .claude/skills/bundle-authoring/SKILL.md
  is generated by cairn from bundle 'cairn-agent' (claude-code/project).

Edit the source instead:
  plugins/cairn-agent/skills/bundle-authoring/SKILL.md

Then regenerate:
  cairn agent install
```

## The hook

The hook that runs before every write is **not** this command. It is `.cairn-guard.sh`, a
POSIX `sh` script [`agent install`](install.md#the-edit-guard) generates at each project-scope
destination and registers in the host's project hook document, with the install inventory
baked in. It forks nothing on the allow path and never starts Node.

It used to be this command: the `cairn-agent` plugin shipped a global `pre-tool-use` hook
that spawned `cairn agent guard` on every edit in every repository, and the two Node startups
that cost — in every session, on every machine with the plugin, mostly to learn that the
repository declared nothing — pinned machines under parallel agents. The plugin ships no hook
now; the guard exists only where an install put it.

The two answer from different oracles and must agree. This command judges a path against the
target profile's declared output patterns and confirms ownership against the bundle; the
script judges it against the manifest's exact file list. `tests/unit/agent-install-guard.test.ts`
asserts that, for every file an install writes, the script names the same sources this command
does. Use this command when there is no installed guard to ask — from CI, from a Git hook, or
against a tree `agent convert` produced — and read its `--format json` verdict.

## Related surfaces

- [`agent verify`](verify.md) is the CI-facing check that a committed tree still matches its bundle; this one is the interactive check that it stays that way.
- [`agent install`](install.md) writes the trees this command protects, and the `.cairn-guard.sh` hook that protects them at edit time.
- [Target profile](../../formats/target-profile.md) documents the `outputs` patterns the judgement is made against.
- [Project configuration](../../configuration.md#agentguard) documents the `agent.guard` block.
- [Diagnostic codes](../../formats/diagnostic-codes.md) lists every code with its meaning.
