# Markdown conventions

Two markers Cairn writes into Markdown documents, and reads back later. Both are HTML comments
or fence attributes rather than new syntax, so a document carrying them renders normally
everywhere else.

Both are also read under their **pre-rename spelling**. Cairn writes `cairn:` and reads either,
so no committed file needs editing after the rename. `tests/unit/legacy-names.test.ts` is the
contract for that.

## Table-of-contents markers

[`md toc --write`](../commands/md/toc.md) and the `toc` fixer in
[`md fix`](../commands/md/fix.md) maintain the region **between** a marker pair:

```markdown
<!-- cairn:toc:start -->

- [Section](#section)
  - [Subsection](#subsection)

<!-- cairn:toc:end -->
```

The pre-rename pair is `<!-- claude-cli:toc:start -->` / `<!-- claude-cli:toc:end -->`.

### A pair keeps the spelling it was found with

The synchronizer only ever rewrites the interior; it never rewrites the markers themselves, and
it reports the matched pair back to the caller so this stays true through `--write`.

Migrating a legacy pair on write would report every legacy document as **stale** for a change
that alters no table of contents. The two spellings are therefore equal forever, and only a
newly inserted pair uses the current one.

A **mixed** pair — one legacy marker and one current — is `malformed`, not a silent
best-effort match.

### Markers inside code blocks are ignored

A marker occurrence is filtered through `isLineInCodeBlock`, so a fenced example _documenting_
this syntax is not mistaken for a live marker. That filter is necessary here in a way it is
not for snippet links; see below.

### Entries

Entries are rendered from the document's headings, indented two spaces per level below the
shallowest heading present, as `- [text](#slug)` — or `1.` for an ordered list.

## Snippet links

[`md check-snippets`](../commands/md/check-snippets.md) keeps a fenced code block in sync with a
region of a real source file. The link is an attribute in the fence **info string**:

````markdown
```ts cairn:snippet=src/toc.ts#render
export function renderToc(headings: MdHeading[], ordered = false): string {
  …
}
```
````

| Form                                 | Selects                               |
| ------------------------------------ | ------------------------------------- |
| `cairn:snippet=path/to/file.ts`      | the whole file                        |
| `cairn:snippet=path#region`          | a named region within it              |
| `cairn:snippet="path with space.ts"` | quoting is accepted, single or double |

The path is split at the **first** `#`, not the last: a region name may not contain one, but a
path theoretically may, and splitting late would silently mangle it. A region name must match
`^[A-Za-z0-9][A-Za-z0-9._-]*$`.

The pre-rename attribute `claude-cli:snippet=` is read the same way. A fence carrying one of
each counts as two matches and is reported as a duplicate, which is exactly right.

### Region markers in the source

A region is delimited by comments in the source file, in whatever comment syntax that language
uses:

```ts
// cairn:snippet:start render
export function renderToc(…) { … }
// cairn:snippet:end render
```

The pattern is deliberately **unanchored**: the comment leader (`//`, `#`, `--`, `/*`, `<!--`)
is not knowable, and whatever trails the name on the line is ignored. It is a regular
expression rather than a substring test so that the name is captured and so that
`cairn:snippet:startup` cannot match `…:start`.

Region markers live in source files, which this command only ever **reads**, so accepting both
spellings there costs nothing and there is never anything to migrate.

The extracted region is dedented by stripping the longest common **literal** leading-whitespace
prefix — a literal prefix rather than a column count, so a region mixing a tab-indented and a
space-indented line yields an empty prefix instead of mangling one of them.

### The link is read from the AST, never by scanning

This is the whole reason the syntax lives in the fence info string rather than in a comment.

`Code.meta` comes from the Markdown AST. remark reports an inner fence as _characters inside
the outer block's value_ rather than as a code node, so a fenced example documenting this
syntax is **unreachable by construction** — not merely guarded.

A line-scanning implementation would reintroduce exactly the hazard the TOC markers have to
guard against, with no guard available on this side, and would make this repository's own
`docs/commands/md/check-snippets.md` go live. `tests/e2e/cli.test.ts` runs
`md check-snippets docs README.md` over this repository and asserts exit `0`.

### A fence with no language

A fence with no language puts the whole info string into `lang`, so an attribute written there
would land in the wrong field and be silently inert forever. That case is detected and reported
as `no-language` with the fix: write ` ```text cairn:snippet=… `.

### Read and write boundaries differ

`md check-snippets` bounds reads and writes by **different roots**, deliberately:

- **Source reads** are confined to `config.root`, because a document under `docs/` legitimately
  points at `../src`
- **Writes** use the `md fix` containment root, which for `md check-snippets docs` is `docs/`
  and would reject every real source

`--write` copies arbitrary file contents into tracked documents, so the read guards — realpath
containment, regular-file, a 2 MiB size cap, and a NUL-byte binary check — are the feature's
security boundary rather than hygiene. `check`, `write`, and `dryRun` stay out of the
configurable command options for the same reason.

### The snippets fixer is not in the `md fix` default set

`md fix` with no `--rule` runs only fixers marked `default`, and `snippets` is not one. It is
the only fixer whose edits are decided by files **other than** the Markdown being fixed, and a
broadly-run `md fix --write` must not silently acquire that reach.

## Frontmatter

`md validate-frontmatter` and `md frontmatter` read standard YAML frontmatter delimited by
`---`. The rules a workspace enforces are configuration rather than a file format; see
[Frontmatter rule value types](../configuration.md#frontmatter-rule-value-types).

**A frontmatter block is not a heading.** Only a block at the very start of a document counts;
everywhere else `---` remains a thematic break or a setext underline, and a real setext heading is
unaffected. The block keeps its own position in the tree, so every later node reports its original
line number.

That is worth stating because the alternative is silent and wrong. Without frontmatter awareness a
leading `---` block is not recognized at all: the closing `---` reads as a setext underline, and
the YAML body becomes an `<h2>` whose text is the raw keys — including the newlines between them.
Every heading consumer inherited it, and `md toc` emitted a link label containing a literal
newline, which is not valid Markdown.

## Target-conditional blocks

Markdown inside an agent bundle may also carry target-conditional regions:

```markdown
<!-- target:cursor -->

Cursor-specific instructions.

<!-- /target:cursor -->
```

That is a bundle-format concern rather than a workspace one; see
[Agent bundle format](agent-bundle.md#conditional-blocks).

## Related

- [`md toc`](../commands/md/toc.md), [`md check-snippets`](../commands/md/check-snippets.md),
  [`md fix`](../commands/md/fix.md)
- [Project configuration schema](../configuration.md)
- [Audit baselines](audit-baseline.md)
