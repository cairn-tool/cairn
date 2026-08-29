# `md check-snippets`

## Synopsis

```text
cairn md check-snippets [inputs...] [options]
```

Compares fenced code blocks against the source files and regions they declare, and optionally
refreshes them. A snippet is **never executed** — the source file is only read.

Only fences whose info string carries a `cairn:snippet=` attribute are considered. Every
other fence costs one substring test and is absent from the payload.

## Arguments

| Argument    | Required | Description                                                                      |
| ----------- | -------- | -------------------------------------------------------------------------------- |
| `inputs...` | No       | Markdown files, directories, or globs. Defaults to the workspace root. No stdin. |

Stdin is rejected because `--write` has no path to write back to, and a snippet path is
resolved relative to the document that declares it.

## Options

| Option                             | Default         | Description                                 |
| ---------------------------------- | --------------- | ------------------------------------------- |
| `--format <fmt>`                   | Project default | `llm`, `human`, or `json`.                  |
| `--paths <style>`                  | Project default | `absolute` or `relative`.                   |
| `--check`                          | **Default**     | Report drift without writing.               |
| `--dry-run`                        | Off             | Print the full plan, including both bodies. |
| `--write`                          | Off             | Refresh linked blocks as one transaction.   |
| `--include-ok` / `--no-include-ok` | `false`         | Include up-to-date snippets in output.      |
| `--include <glob>`                 | `files.include` | Repeatable include glob.                    |
| `--exclude <glob>`                 | `files.exclude` | Repeatable exclude glob.                    |
| `-h`, `--help`                     | —               | Show help.                                  |

`--check`, `--dry-run`, and `--write` are mutually exclusive. **The mode cannot be set from
project configuration**: `check`, `write`, and `dryRun` are deliberately absent from
`commands.check-snippets`, on the same rule as `md fix`. It matters more here than anywhere
else, because `--write` copies the contents of source files into tracked documents.

## Declaring a link

Put the attribute in the fence info string, after the language:

````text
```ts cairn:snippet=src/toc.ts#render
export function renderToc(headings: MdHeading[], ordered = false): string {
  ...
}
```
````

| Form                              | Selects                                                |
| --------------------------------- | ------------------------------------------------------ |
| `cairn:snippet=src/a.ts#render`   | The region named `render` in `src/a.ts`.               |
| `cairn:snippet=.markdownlintrc`   | The whole file.                                        |
| `cairn:snippet=/src/a.ts#render`  | Workspace-root-relative rather than document-relative. |
| `cairn:snippet="src/my dir/a.ts"` | A path containing a space.                             |

An unquoted value ends at the first space, so other attributes in the same info string —
`title=`, a Prism line range — are left alone and are never rewritten. A region name is
`[A-Za-z0-9][A-Za-z0-9._-]*`.

The **language is required.** A fence with no language puts the whole info string into the
language slot, where the attribute would be silently inert forever; that is reported as a
`no-language` finding rather than skipped. Use `text` when the snippet has no language.

## Declaring a region

In the source file, mark the region with a comment. The marker is matched inside the line, so
the comment leader does not matter and anything after the name on the line is ignored:

```ts
// cairn:snippet:start render
export function renderToc(...) { ... }
// cairn:snippet:end render
```

```python
# cairn:snippet:start render
def render(): ...
# cairn:snippet:end render
```

The end marker names its region, which is what lets regions nest or overlap freely: pairing is
by name, never by nesting depth. Marker lines belonging to a nested region are stripped from
the extracted body, so a region's scaffolding never reaches the documentation.

The extracted body has leading and trailing blank lines trimmed and is then dedented by the
longest common **literal** leading-whitespace prefix of its non-blank lines. A literal prefix
rather than a column count, so a region mixing tab- and space-indented lines is left alone
instead of having one of them mangled.

When the source file is itself Markdown, marker lines inside fenced code are skipped — the
same guard TOC marker synchronization applies, so a document explaining this syntax does not
appear to declare a region.

## What counts as drift

Both bodies are compared after normalizing exactly three things, and nothing else:

- line endings (`\r\n` and lone `\r` become `\n`);
- trailing horizontal whitespace on each line;
- trailing blank lines.

These three are ignored because these three are applied by ambient tooling without an author's
intent — `core.autocrlf`, editor trim-on-save, formatter final-newline rules. Everything else,
including indentation _inside_ the snippet, is a genuine difference and is reported.

`--write` emits that same normalized form, so writing and then checking is clean by
construction.

## What `--write` will not do

A block is refreshed only when the fence can accept the new body. Otherwise the drift is still
reported, the block is left alone, and **other blocks still refresh**:

| Reason               | Condition                                                                                          |
| -------------------- | -------------------------------------------------------------------------------------------------- |
| `fence-collision`    | The source contains a line that would close the fence early. Use a longer fence.                   |
| `container-prefix`   | The fence is in a blockquote, or its lines are not uniformly indented.                             |
| `unterminated-fence` | The fence is closed by end of file. Adding the closing line would change the document's structure. |
| `not-a-fence`        | An indented code block, which has no fence to rewrite.                                             |

A fence indented inside a **list item** _is_ refreshed, with its indentation re-applied. Only
the interior is ever rewritten, so the fence line — and every attribute on it — survives byte
for byte.

Writing goes through the same transaction as `md fix`: every file is rechecked and every
expected span re-verified before anything is staged, then each file is committed by rename.
Every **source** file is fingerprinted at plan time and re-checked before applying, because
the transaction itself only knows about the documents it edits.

## Reading a source file

Source paths resolve like a Markdown link target: a leading `/` is workspace-root-relative,
anything else is relative to the document. A read is refused, as an `unresolved` finding, when
the source:

- resolves outside the workspace root, lexically or through a symlink;
- is not a regular file — a FIFO would otherwise block the read forever;
- is larger than 2 MiB;
- contains a NUL byte, which would decode to replacement characters.

Reads are bounded by the **workspace root**, not by the write containment root, because a
document under `docs/` legitimately points at `../src`. Writes stay inside the `md fix`
containment root.

## Exit codes

| Mode                    | Condition                                              | Code | Stream |
| ----------------------- | ------------------------------------------------------ | ---- | ------ |
| `--check` / `--dry-run` | Drift                                                  | `2`  | stderr |
| any                     | A link that could not be resolved, or a malformed link | `2`  | stderr |
| `--dry-run` / `--write` | A fence that cannot accept its refreshed body          | `2`  | stderr |
| any                     | An edit-plan conflict, so nothing was written          | `2`  | stderr |
| `--write`               | Refreshed, or nothing to do                            | `0`  | stdout |
| any                     | Every linked snippet matches                           | `0`  | stdout |
| any                     | Bad invocation, stdin, two modes, or an I/O error      | `1`  | stderr |

Unlike `md fix`, a finding with **no available fix fails every mode, including `--write`**. A
snippet naming a deleted file or a deleted region is the most severe drift this command can
find, and its job is checking rather than fixing — exiting `0` would let CI pass over provably
wrong documentation. Drift alone only fails the modes that are not about to correct it.

## Related surfaces

The same engine backs two other commands:

- `cairn md fix --rule snippets` plans the refresh as ordinary fix edits. It is **opt-in**:
  a bare `md fix` runs every default fixer, and that broadly-run command must not silently
  acquire the reach to read arbitrary source files.
- `cairn md audit` reports drift under the `snippets/drift`, `snippets/source`,
  `snippets/region`, and `snippets/meta` checkers. On by default, and free for a workspace with
  no linked fence. Messages carry no line number and no absolute path, so `--baseline` entries
  stay portable.

## Formatting caveat

Prettier reformats embedded code inside Markdown fences for the languages it knows (`ts`, `js`,
`json`, `css`). A byte-exact snippet in one of those languages will drift the moment Prettier
touches the document. If the project formats its Markdown, pick one of:

- `<!-- prettier-ignore -->` immediately above each linked fence;
- an `embeddedLanguageFormatting: "off"` override for `*.md` in the Prettier config;
- a `.prettierignore` entry for the affected documents.

Similarly, markdownlint's `MD010` rewrites tabs **inside** fences and is in the `md fix`
allowlist, so a tab-indented source and `md fix --rule markdownlint,snippets --write` edit the
same span. That surfaces as an edit-plan conflict and refuses rather than fighting across runs,
but `MD010: { code_blocks: false }` avoids it entirely.
