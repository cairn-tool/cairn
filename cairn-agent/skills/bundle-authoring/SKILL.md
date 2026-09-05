---
name: bundle-authoring
description: Author a portable agent bundle with the cairn agent toolset — scaffold it, add skills, subagents, rules, hooks, policies, and MCP config, then render it for each host. Use when creating or editing plugin content that should work on more than one assistant, or when importing an existing native plugin into a portable form.
---

# Authoring a portable agent bundle

`cairn` must be on `PATH`. Every command takes `--format llm|human|json` (`-fh`/`-fj`) and exits
`0` clean, `1` on a usage error, `2` when it found something.

Longer conventions: [`${CLAUDE_PLUGIN_ROOT}/assets/cli-basics.md`](../../assets/cli-basics.md).

## The idea

Write the content once, in a host-neutral form, and let `agent convert` render it for Claude Code,
Codex, Cursor, Antigravity, and OpenCode. A bundle is a directory holding `agent-bundle.yaml` and
component directories — plain YAML, Markdown with frontmatter, JSON, and assets.

## Scaffold and grow

```bash
cairn agent init my-bundle
cairn agent init my-bundle --component skill --component agent --component hook
cairn agent add skill prepare-release ./my-bundle
cairn agent add hook pre-tool-use ./my-bundle
cairn agent add mcp servers ./my-bundle
```

Both are fully noninteractive with `--dry-run` and `--check`, and report a machine-readable plan,
so you never have to parse prompts.

`agent add` leaves `agent-bundle.yaml` **byte-untouched** unless a component root actually needs
recording — a round trip would otherwise churn whitespace on every call.

## Seven component kinds. There is no `commands` kind

| Kind       | Location   | Contains                              |
| ---------- | ---------- | ------------------------------------- |
| `skills`   | `skills`   | `<name>/SKILL.md` directories         |
| `agents`   | `agents`   | `*.agent.md`                          |
| `rules`    | `rules`    | `*.md` with an `activation`           |
| `hooks`    | `hooks`    | a hooks document plus handler scripts |
| `policies` | `policies` | command-permission documents          |
| `mcp`      | `mcp`      | an MCP server document                |
| `assets`   | `assets`   | anything, copied verbatim             |

**A slash command is a skill**, not a separate kind. Set `invocationPolicy: explicit` and it
renders as the host's "user-invocable only" form — `disable-model-invocation: true` on Claude
Code. Add `argumentHint` for the autocomplete hint. Both are portable and translated per target;
do not reach for a native overlay to get a command.

```markdown
---
name: md-lint
description: Lint a Markdown file.
invocationPolicy: explicit
argumentHint: "[path]"
---
```

Any frontmatter key the parser does not recognize is passed through to the rendered document
unchanged — which is how you set a host-specific field, and also why a typo in a key name is
carried through silently rather than reported.

## Required manifest fields

`schemaVersion`, `name` (kebab-case), `version` (semver), and `description`. Schema `2` is current
and is a strict superset of `1`: it adds `marketplace:` and `native:` and changes nothing else.

Set `marketplace.publisher.name` early. `agent init` scaffolds it empty, which **validates
cleanly** — publish-readiness is `agent package`'s question, not the parser's — so a missing
publisher does not surface until much later, as `AB500`.

## Writing for more than one host

Three placeholders are translated, or replaced with explanatory prose where a host has no
equivalent:

| Canonical        | Becomes on Claude Code                              |
| ---------------- | --------------------------------------------------- |
| `${CLAUDE_PLUGIN_ROOT}` | `${CLAUDE_PLUGIN_ROOT}`, or `${CLAUDE_PROJECT_DIR}` |
| `$ARGUMENTS`   | `$ARGUMENTS`, substituted natively                  |
| `${CLAUDE_SKILL_DIR}`   | `${CLAUDE_SKILL_DIR}`                               |

For genuinely host-specific prose, use a conditional block rather than forking the file. The
one-target form:

```markdown
<!-- target:cursor -->

Cursor-specific instructions.

<!-- /target:cursor -->
```

The branching form, where a comma list is an OR and `not` negates the whole list:

```markdown
<!-- if target:claude-code -->

!`git status --short`
<!-- elif target:codex, cursor -->

Run `git status --short` and read the output before continuing.
<!-- else -->

Check the working tree before continuing.
<!-- endif -->
```

An unmatched, misnested, or unclosed block is an error (`AB121`), and so is a marker that
_looks_ conditional but does not parse (`AB123`) — `<!-- target: cursor -->` with a space after
the colon used to be silently inert. Blocks are validated in **every** file the renderer
processes them in, which is every textual asset and not only Markdown.

Markers inside a fenced code block or an inline code span are inert, so a skill may document
this syntax without its own examples being stripped.

Use `include:`/`exclude:` frontmatter to emit a component for some targets only.

## Check as you go

```bash
cairn agent validate ./my-bundle --target all
cairn agent inspect ./my-bundle --target codex --profile plugin
cairn agent compat ./my-bundle --target codex --target cursor
cairn agent convert ./my-bundle --target all --output ./dist --profile both
```

`agent compat` is the one to run before promising a feature works everywhere — support varies, and
"approximate" means the mapping is reported as lossy rather than claimed as faithful.

Two profile facts that catch people out: **rules render project-profile only** on Claude Code (a
plugin has no rules surface), and **hooks render plugin-profile only**. A bundle whose rules
matter must ship the project profile.

## Importing an existing plugin

```bash
cairn agent import ./existing-plugin --output ./my-bundle
```

Detects the layout from the same target profiles the renderer uses. Untranslatable pieces are
preserved under `native/<target>/` rather than dropped, and every input file gets a provenance row
in `import-report.json`.

A tree holding only `.agents/skills/<name>/` is genuinely ambiguous between Antigravity and Codex,
and `import` throws naming the candidates rather than guessing. Pass `--from` to settle it.

For a whole **repository** rather than one plugin — surveying what is there, triaging the
overlays, regenerating, and wiring drift detection — run `/agent-migrate`, which walks that
sequence with confirmation gates.

## More

Full flags, the frontmatter tables, and the diagnostic codes are in
[`reference/bundle-format.md`](reference/bundle-format.md). Testing is the `bundle-testing`
skill; packaging and installing are `bundle-publishing`.
