# Cutover and rollback

Read this at steps 4, 7, and 8 — after the first successful import, not before.

## Promote, or keep as an overlay?

`agent import` preserves anything it cannot translate under `native/<target>/`. That is a
holding pen, not a destination. For each file:

| Keep as an overlay when                                     | Promote when                                        |
| ----------------------------------------------------------- | --------------------------------------------------- |
| The surface has no portable equivalent at all.              | A portable component kind covers it.                |
| It is genuinely one host's feature and always will be.      | You would want it on a second host later.           |
| It is a config file the host owns and cairn does not model. | It is a skill, subagent, rule, hook, or MCP server. |

The cost of an overlay is real and worth stating plainly: it is copied **verbatim**. No
placeholder rewriting, no conditional-block processing, and no conformance checking — `agent
doctor` lists overlay paths under `doctor.overlays` rather than validating them, because
emitting a surface the portable profile does not describe is the whole point of an overlay.
Anything you leave there stops being portable.

The most common promotion: a hand-written "slash command" file becomes a skill with
`invocationPolicy: explicit`. There is no `commands` component kind, and reaching for an
overlay to get one is the mistake this step exists to catch.

## Commit the generated tree, or build it in CI?

|                                 | Commit it | Build it |
| ------------------------------- | --------- | -------- |
| Contributors see the real files | yes       | no       |
| Works with no cairn installed   | yes       | no       |
| Diff noise on every bundle edit | yes       | no       |
| Needs a build step in CI        | no        | yes      |
| Risk of hand edits              | real      | none     |

**Committing is the usual answer** for a repository whose contributors use the assistant
day to day: the content has to be on disk for the host to read it, and a fresh clone should
work without a build. The cost is that a hand edit is invisible until someone notices — which
is exactly what `agent verify` closes.

If you build instead, add the generated paths to `.gitignore` and generate in the same job that
runs the tests, so a broken bundle fails before anything is published.

Either way, add the generated tree to `CODEOWNERS` pointing at whoever owns the bundle, so an
edit to output gets the same review as an edit to source.

## Wiring drift detection

Declare what to check in a cairn configuration document, then run one command in CI:

```yaml
version: 1
agent:
  verify:
    pins:
      cli: { min: "2.0.0" }
      profileSchemaVersion: "2"
      targets:
        claude-code: { min: "2026-08-02" }
    defaults: { unmanaged: orphaned, scope: project }
    entries:
      - bundle: agent-bundle
        target: claude-code
        profile: project
        destination: .
```

```bash
cairn agent verify
```

Three things to get right:

- **Pin after the first clean run, not before.** Run it once with no `pins:` block; every pin is
  reported as `unpinned` with the running value beside it, and those values are what to write in.
- **Do not declare an entry for a target that claims a file you hand-maintain.** `AGENTS.md` is
  the one: Codex and OpenCode both render project rules there, and a declared path is compared
  byte for byte. Verifying a `codex`/`project` entry against a repository with its own
  `AGENTS.md` will report drift forever, correctly.
- **Leave `unmanaged` at `orphaned` in CI.** It reads the recorded inventory rather than walking
  the filesystem, so it costs nothing on a checkout full of dependencies, and it still catches
  the important case — a file the bundle used to render and no longer does. `strict` adds a
  bounded walk that finds hand-added files; turn it on once the tree is stable.

## Re-importing later

If the native tree moves on before you cut over, re-import over the same bundle with a `--merge`
strategy rather than starting again, and re-read `import-report.json` — the provenance rows are
what tell you whether a file you promoted got claimed differently the second time.

## Rollback

Every step before 9 is non-destructive: the originals are still there, and the bundle is new
files. To back out, delete the bundle directory and the generated tree.

After step 9 the originals are gone from the working tree, which is why it is a commit of its
own — `git revert` on that one commit restores them without undoing the import.
