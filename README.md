# claude-cli

An agent-agnostic CLI toolkit for working with Markdown files and related assets. Despite
the name, `claude-cli` is intended to support all LLM coding agents, as well as humans and
CI systems; its commands do not depend on Claude or any model-provider API.

Published as `@bstockus/claude-cli` on the GitHub Packages npm registry; the installed
binary is named `claude-cli`.

## Install

The package is private, so npm needs to know where the `@bstockus` scope lives and how to
authenticate. Add this to your **`~/.npmrc`** once, using a GitHub personal access token
with the `read:packages` scope:

```ini
@bstockus:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=<YOUR_PAT>
```

Then:

```bash
npm install -g @bstockus/claude-cli   # global `claude-cli` binary
npx @bstockus/claude-cli md lint FILE # one-off, no install
```

### Keeping a stable path across Node upgrades

`npm install -g` places the binary inside the active Node install. Under a version manager
such as nvm that directory changes on every Node upgrade, which silently breaks anything
holding an absolute path to the CLI (Claude Code hooks, for example). Pin a stable path:

```bash
mkdir -p ~/.local/bin
ln -sf "$(npm root -g)/@bstockus/claude-cli/dist/cli.js" ~/.local/bin/claude-cli
```

Make sure `~/.local/bin` is on your `PATH`.

### Installing from source with `npm link`

Skip the registry entirely and link a local clone if you don't have a GitHub Packages
token, or want to run a specific commit instead of the latest published release:

```bash
git clone git@github.com:bstockus/claude-cli.git
cd claude-cli
npm ci
npm run build   # tsc -> dist/cli.js
npm link        # symlinks the global `claude-cli` binary to this working tree
```

`npm link` points the global `claude-cli` binary at `dist/cli.js` in this working tree
instead of copying files, so pulling new commits only requires `npm run build` again — no
need to re-run `npm link`. Remove the link with:

```bash
npm unlink -g @bstockus/claude-cli
```

## Development

```bash
git clone git@github.com:bstockus/claude-cli.git
cd claude-cli
npm ci

npm test           # builds dist/ via `pretest`, then runs unit/integration/e2e suites
npm run test:watch
npm run build      # tsc -> dist/
npm run lint       # ESLint
npm run format     # Prettier (write); `npm run format:check` in CI
npm run typecheck  # tsc --noEmit

npm link           # expose the working tree as the global `claude-cli`, see Install above
npm unlink -g @bstockus/claude-cli
```

The e2e suite spawns the **compiled** `dist/cli.js`, so a build must precede it — `pretest`
handles that automatically.

## Releasing

Releases are fully automated. Every push to `main` runs
[semantic-release](https://github.com/semantic-release/semantic-release), which derives the
next version from the commit messages, tags it, writes `CHANGELOG.md`, creates a GitHub
Release, and publishes to GitHub Packages. Nothing is versioned by hand — `version` in
`package.json` is managed by the release job.

Commits **must** follow [Conventional Commits](https://www.conventionalcommits.org/); a
`commit-msg` hook and a CI job both enforce it.

| Commit prefix                    | Effect        |
| -------------------------------- | ------------- |
| `fix:` / `perf:`                 | patch release |
| `feat:`                          | minor release |
| `feat!:` or `BREAKING CHANGE:`   | major release |
| `chore:` `docs:` `test:` `ci:` … | no release    |

## Update checks

The CLI checks whether a newer version has been published and prints a notice:

```text
Update available 1.0.3 → 1.1.0
Run npm install -g @bstockus/claude-cli to update.
```

The check runs **at most once every 24 hours**, in a detached background process, so it
never delays a command. The notice itself is printed from the cached result, which means
it appears at most 24 hours after a release.

It is deliberately silent unless it is safe and useful to speak. No notice is printed when:

- stderr is not a TTY — output is being piped or parsed
- `--format json`, `jsonl`, or `sarif` is in use
- `CI` is set
- `CLAUDE_CLI_NO_UPDATE_NOTIFIER=1` is set

Set `CLAUDE_CLI_NO_UPDATE_NOTIFIER=1` to disable the feature entirely, including the
background refresh.

The cached result lives at `${XDG_CACHE_HOME:-~/.cache}/claude-cli/update-check.json` and
can be deleted at any time to force a fresh check.

### `check-update`

Checks immediately, querying the registry directly rather than reading the 24h cache.

```bash
claude-cli check-update
claude-cli check-update --format json
```

Exit codes:

- `0` - Already on the latest version
- `1` - Could not reach the registry
- `2` - A newer version is available

## Shell completion

```bash
claude-cli completion bash       >> ~/.bashrc
claude-cli completion zsh        > ~/.zfunc/_claude-cli    # a directory on $fpath
claude-cli completion fish       > ~/.config/fish/completions/claude-cli.fish
claude-cli completion powershell >> $PROFILE
```

The script is generated from the same command tree `describe` walks, so it cannot drift from
the real commands and options. It completes subcommands, fixed-vocabulary arguments such as
`md query <kind>`, and enumerated option values — including `--format`, whose values come from
each command's contract, so `md audit --format` offers `jsonl` and `sarif` while
`md graph --format` does not. File and directory values defer to the shell's own completion.

The script embeds the command tree rather than calling back into the CLI, so completing costs
no process spawn; regenerate it after upgrading. `claude-cli` never writes to a shell profile
itself, and the update notice is suppressed for this command so the `eval` install idiom cannot
print on every shell start.

## Common Options

All `md` subcommands support:

- `--format <fmt>` - Output format: `llm` (default), `human`, or `json`; `lint`,
  `lint-dir`, `audit`, `validate-frontmatter`, and `check-urls` also support `jsonl` and `sarif`
- `-fh` - Shorthand for `--format=human`
- `-fj` - Shorthand for `--format=json`
- `--paths <style>` - Display paths as `absolute` (default) or `relative` to the workspace
- `--stdin-name <path>` - Give stdin a workspace path when file-relative links must be resolved
- `--config <file>` - Use a specific `.claude-cli.yml`
- `--no-config` - Disable automatic project configuration discovery

### Project configuration

For `md` commands, the CLI searches from the current directory upward for
`.claude-cli.yml`. Command-line options override command-specific settings, which override
top-level settings, which override built-in defaults. Configuration-derived paths are
relative to the configuration file; explicit CLI paths remain relative to the invocation
directory.

```yaml
version: 1
root: docs

files:
  include: ["**/*.md"]
  exclude: ["archive/**", "generated/**"]
  entryPoints: ["docs/README.md"]

assets:
  extensions: [".png", ".jpg", ".svg", ".pdf"]

markdown:
  renderer: github

output:
  format: llm
  paths: relative

checks:
  mermaid: true
  katex: true
  references: true
  markdownlint: false
  graph: true
  frontmatter: true
  toc: true
  external: false
  snippets: true

frontmatter:
  schema: schemas/document.yml
  rules:
    required: [title, metadata.owner]
    prohibited: [draftPassword]
    types: { title: string }
    allowedValues: { status: [draft, published] }
    formats: { publishedAt: date-time }
    patterns: { slug: "^[a-z0-9-]+$" }
    unique: [id, slug]

toc:
  files: ["README.md", "guides/**/*.md"]

markdownlint:
  config: .markdownlintrc

urls:
  ignore: ["https://example.invalid/**"]
  ignoreDomains: ["private.example.com"]
  allowedStatuses: [401, 403]
  cache: true
  cacheTtl: 86400000
  headFallbackStatuses: [400, 403, 405, 501]
  reportRedirects: false

commands:
  lint-dir:
    summary: true
    concurrency: 4
  toc:
    minDepth: 2
    maxDepth: 4
  graph:
    entry: [docs/README.md]
  audit:
    summary: true
```

`commands` uses the CLI command names and camel-case option names. It accepts defaults for
each command's non-positional options. Boolean defaults can always be reversed with the
corresponding `--no-*` option. Repeated CLI list options replace configured lists.
For URL checks, CLI options override `commands.check-urls`, which overrides the top-level
`urls` values shown above, which override the built-in defaults.

Directory commands use the configured include/exclude globs consistently. `.git` and
`node_modules` are always excluded, and directory symlinks are not followed. `lint-dir` and
`orphans` default to the workspace root when their directory argument is omitted;
`refs-to` uses it as the default search directory.

### Exit Codes

- `0` - Success / no issues
- `1` - Usage error (file not found, heading not found, etc.)
- `2` - Actionable issues found (broken links, orphans, etc.)

### Machine-readable output

JSON output is a documented API, not something to reverse-engineer. `describe` reports every
command with its options, exit code meanings, output stream, and output schema id; `schema`
retrieves the schemas themselves.

```bash
claude-cli describe --format json           # the whole contract
claude-cli describe md graph --format json  # one command
claude-cli schema                           # published schemas
claude-cli schema md-graph                  # one schema document
```

Existing payloads are unchanged. Pass `--envelope` alongside `--format json` for a uniform
wrapper carrying the command id, exit code, and schema id, with the payload verbatim under
`data`:

```bash
claude-cli md graph docs --format json --envelope
```

See [docs/contract.md](docs/contract.md) for the versioning rules, the stream guarantees, and
what does and does not count as a breaking change.

## Commands

### Agent bundle conversion

The top-level `agent` toolset converts one neutral bundle into Claude Code, Codex, and
Cursor artifacts. Agent-bundle defaults deliberately live in `agent-bundle.yaml`; the
`.claude-cli.yml` configuration described above remains scoped to `md` commands.

```bash
claude-cli agent init release-helper --output ./my-bundle
claude-cli agent import ./existing-plugin --output ./my-bundle
claude-cli agent add skill prepare-release ./my-bundle
claude-cli agent add hook pre-tool-use ./my-bundle
claude-cli agent upgrade ./my-bundle --to-schema 2 --check
claude-cli agent validate ./my-bundle --target all
claude-cli agent inspect ./my-bundle --format json
claude-cli agent inspect ./my-bundle --target codex --profile plugin
claude-cli agent compat
claude-cli agent compat ./my-bundle --target codex --target cursor
claude-cli agent specs --format json
claude-cli agent doctor ./my-bundle --target all --output ./dist
claude-cli agent convert ./my-bundle --target all --output ./dist --profile both
claude-cli agent package ./my-bundle --target all --output ./release --archive
claude-cli agent install ./my-bundle --target cursor --scope user
claude-cli agent install ./my-bundle --target claude-code --scope user --register
claude-cli agent installed
claude-cli agent uninstall markdown --target cursor --scope user
claude-cli agent audit ./my-bundle --target all --format sarif
claude-cli agent test ./my-bundle --target all --strict
claude-cli agent convert ./my-bundle --target cursor --output ./dist --dry-run
claude-cli agent convert ./my-bundle --target all --output ./dist --check
claude-cli agent convert ./my-bundle --target all --output ./dist --dry-run --report ./ci/convert.json
```

`agent import` is the inverse of `agent convert`: it turns an existing native plugin or
project into a portable bundle, detecting the layout from the same target profiles the
renderer uses. Untranslatable pieces are preserved under `native/<target>/` rather than
dropped, and every input file gets a provenance row in `import-report.json`.

`agent init` scaffolds a minimal, valid `schemaVersion: '2'` bundle and `agent add` adds one
component at a time. Both are noninteractive, support `--dry-run`/`--check`, and report a
machine-readable plan, so an agent can drive them without parsing prompts. `agent add` leaves
`agent-bundle.yaml` byte-untouched unless a component root actually needs recording.

`agent inspect` accepts `--target` and `--profile` to narrow a large normalized bundle to the
components that reach the selected targets and the sections the selected profiles emit. It uses
the renderer's own selection predicate and the target conformance profiles, so it cannot
disagree with `agent convert`, and it reports what it excluded under `bundle.filter`. Without
either flag the payload is unchanged.

`--target` is repeatable and accepts `claude-code`, `codex`, `cursor`, or `all`.
`--profile` accepts `plugin`, `project`, or `both` (the default). Existing nonempty selected
destinations require `--force`; conversion never prompts. `--strict` blocks writes when an
approximate or unsupported mapping is found. `--dry-run` performs the complete render in
memory, while `--check` compares generated bytes and executable modes without writing.

`agent package` is a separate stage from conversion so that `convert` stays a pure compiler.
It renders the bundle itself — so a package can never certify a stale tree — then adds
marketplace catalogs, `sha256sum`-compatible checksums, a file inventory, and optional
byte-reproducible `.tar.gz` archives, with publish-readiness checks over all of it. It never
contacts the network and never publishes.

`agent install` takes that same in-memory render and places it where the host actually
scans: Cursor's user plugin directory, a Claude Code local marketplace, or a project-scope
merge. Copy is the default; `--link` materializes once under the bundle's `.install/` tree
and symlinks the host path at it. `--register` is the only flag that edits host config, and
only Claude Code's marketplace layout needs it. `agent uninstall` removes exactly the
inventory recorded in `.claude-cli-install.json`, and `agent installed` lists what those
manifests describe.

`agent audit` answers the question validation does not: what should a reviewer inspect before
trusting or distributing this bundle? It reports the commands its hooks and MCP servers would
run, the credentials and environment they are handed, how broad its permission grants are,
what executables and binaries it carries, and — against a previous package's `sbom.json` —
what changed since the last release. It is explainable static analysis with stable diagnostic
IDs and SARIF output, not a sandbox or a malware detector: nothing is executed, and exit `2`
means there are findings to review, never that a bundle is malicious.

`agent test` runs contract tests stored with the bundle, under `tests/*.test.yaml`. A case
asserts what a bundle actually renders — the paths it emits for a target and profile, a
fragment of a rendered manifest, a substituted placeholder, a diagnostic that must or must not
appear, a golden digest over the whole tree — so a rename, a refactor, or a revised target
profile cannot change the output silently. It is model-free by construction: expectations are
evaluated against the same in-memory render `agent convert` would write, nothing is executed,
and nothing is written, including the golden digests, which are reported for you to paste back
rather than rewritten in place.

Target behavior is described by versioned conformance profiles that the renderer itself
reads, so what `agent specs` publishes cannot drift from what `agent convert` produces.
`agent doctor` checks a bundle, and optionally an existing generated tree, against those
profiles — it is how you detect a generated plugin that has silently gone stale. It never
runs a host's own tooling, so its result does not depend on what is installed locally.

Every conversion uses this deterministic layout:

```text
<output>/
  claude-code/{plugin,project}/
  codex/{plugin,project}/
  cursor/{plugin,project}/
  conversion-report.json
```

JSON output is one parseable object on stdout. Exit `0` means the requested operation was
lossless, exit `1` is an invocation/path/I/O error, and exit `2` reports validation,
compatibility, strict-mode, or stale-check findings. Non-strict conversion writes usable
artifacts before reporting compatibility losses; hard validation errors and strict failures
do not write.

#### `agent-bundle.yaml`

`schemaVersion` is `1` or `2`. Schema 2 is a strict superset: it adds `marketplace:` listing
metadata and a `native:` overlay layer, and leaves everything else identical, so a v1 bundle
renders exactly the same bytes under either version.

The required fields are `schemaVersion`, `name`, `version`, and `description`. Component
locations default to `skills/`, `agents/`, `hooks/`, `rules/`, `policies/`, `mcp/`, and
`assets/`; replace any default with a string path or `{ path: ... }` at the top level or
under `components`. Paths must stay inside the source root, including after resolving
symlinks.

```yaml
schemaVersion: "1"
name: release-helper
version: 1.0.0
description: Prepare and verify releases.

components:
  skills: skills
  agents: agents
  hooks: hooks/hooks.yaml
  rules: rules
  policies: policies
  mcp: mcp/mcp.yaml
  assets: assets
```

Skills use the open `skills/<name>/SKILL.md` layout and require `name` and `description`
frontmatter. Agents use `agents/*.agent.md` with `name`, `description`, semantic `model`
(`fast`, `balanced`, `capable`, or `inherit`), optional `reasoning`, capability `tools`,
preloaded `skills`, hooks, and MCP dependencies. Instruction rules are Markdown with
`activation: always|files|model|manual` and optional `globs`. Policies are YAML/JSON with a
`rules` array; each rule supplies an argument-prefix `pattern`, `allow|prompt|deny` action,
justification, and `positiveExamples`/`negativeExamples`.

Portable hooks use `session-start`, `pre-tool-use`, `post-tool-use`, and `stop`, with typed
command handlers, matchers, timeouts, optional Windows commands, and `targets` overrides.
Target-only events or protocol differences produce explicit diagnostics rather than being
discarded silently.

Component frontmatter may use `include`/`exclude` target lists and typed
`targets.<platform>` overrides. Markdown supports validated conditional blocks; the legacy
`platform:` spelling remains accepted:

```markdown
<!-- target:cursor -->

Cursor-specific instructions.
<!-- /target:cursor -->
```

#### Native overlays

Not every platform feature has a defensible portable meaning. Rather than forcing one or
dropping it, a `schemaVersion: '2'` bundle can carry target-native files in an overlay that
mirrors the output tree:

```yaml
schemaVersion: "2"
name: release-helper
version: 1.0.0
description: Prepare and verify releases.

marketplace:
  displayName: Release Helper
  categories: [ci, release]
  publisher: { name: Example }
  license: MIT

native:
  claude-code: native/claude-code
```

```text
native/claude-code/
  manifest.json                           # merged over the generated plugin manifest
  plugin/.claude-plugin/marketplace.json  # -> <output>/claude-code/plugin/…
  project/.claude/statusline.json         # -> <output>/claude-code/project/…
```

Overlay files are copied verbatim — no placeholder rewriting, no conditional blocks — and
cannot escape their target root. They carry `"origin": "native"` in JSON output, and
`agent doctor` reports them under `overlays` rather than treating them as undeclared paths.
`marketplace:` is metadata only; `agent convert` ignores it. See
[`agent convert`](docs/commands/agent-convert.md#native-overlays) for the full rules.

Canonical `${ARGUMENTS}`, `${BUNDLE_ROOT}`, and `${SKILL_DIR}` placeholders are translated
to native substitutions where available or explanatory instructions where they are not.
The legacy `$ARGUMENTS`, `${CLAUDE_PLUGIN_ROOT}`, and `${CLAUDE_SKILL_DIR}` forms are also
recognized during migration.

#### Compatibility and migration

| Component      | Claude Code                     | Codex                                   | Cursor                                        |
| -------------- | ------------------------------- | --------------------------------------- | --------------------------------------------- |
| Skills         | Plugin and `.claude/skills`     | Plugin and `.agents/skills`             | Namespaced plugin and `.cursor/skills`        |
| Agents         | Plugin and `.claude/agents`     | `.codex/agents/*.toml` project fallback | Plugin and `.cursor/agents`                   |
| Hooks          | PascalCase portable events      | Portable native events                  | camelCase portable events                     |
| Rules          | `.claude/rules` project         | `AGENTS.md` project layer               | `.cursor/rules/*.mdc`                         |
| Command policy | `.claude/settings.json` project | `.codex/rules/*.rules` project          | Unsupported without an explicit hook override |
| MCP/assets     | Normalized/pass-through         | Normalized/pass-through                 | Normalized/pass-through                       |

This table is a summary. `claude-cli agent specs --format json` is the authoritative,
machine-readable form, and is generated from the same profiles the renderer uses.

Point `agent convert` directly at an existing Claude plugin containing
`.claude-plugin/plugin.json` to migrate it. The importer retains manifest metadata, skills,
agents, hooks, scripts/assets, model mappings, skill embedding, `$ARGUMENTS` behavior,
Claude path variables, Cursor skill namespacing, and `<!-- platform:... -->` conditionals,
and emits a migration notice. Add `agent-bundle.yaml` after reviewing the generated report;
the old Python converter can then be retired independently.

### Validation

#### `md lint <files...>`

Run checks on a single markdown file (mermaid, KaTeX, references).

```bash
claude-cli md lint path/to/file.md
claude-cli md lint --style path/to/file.md
claude-cli md lint "docs/**/*.md" --changed-since origin/main --format sarif
```

Options:

- `-s, --style` - Include markdown style checks (markdownlint)
- `--[no-]mermaid` - Enable or disable Mermaid checks
- `--[no-]katex` - Enable or disable KaTeX checks
- `--[no-]references` - Enable or disable reference checks
- `--changed-since <revision>` - Intersect inputs with changed and untracked Git files

#### `md lint-dir [directory]`

Run checks on all markdown files in a directory.

```bash
claude-cli md lint-dir path/to/directory/
claude-cli md lint-dir --style path/to/directory/
claude-cli md lint-dir --summary path/to/directory/
```

Options:

- `-s, --style` - Include markdown style checks (markdownlint)
- `--summary` - Show one line per file with pass/fail and issue count
- `--concurrency <n>` - Maximum files checked concurrently
- `--include <glob>` / `--exclude <glob>` - Override workspace selection (repeatable)
- `--[no-]mermaid`, `--[no-]katex`, `--[no-]references` - Override configured checks
- `--changed-since <revision>` - Check only selected changed and untracked files

#### `md check-urls <inputs...>`

Validate external URLs in files, directories, globs, or stdin. URLs are deduplicated across the
selection while every source occurrence is retained in the report.

```bash
claude-cli md check-urls path/to/file.md
claude-cli md check-urls --include-ok --timeout 10000 path/to/file.md
claude-cli md check-urls docs "guides/**/*.md" --report-redirects --format jsonl
cat doc.md | claude-cli md check-urls - --stdin-name docs/doc.md
```

Options:

- `--timeout <ms>` - Request timeout per URL in milliseconds (default: 5000)
- `--concurrency <n>` - Maximum concurrent requests (default: 5)
- `--retry <n>` - Number of retries on failure (default: 1)
- `--include-ok` - Include successful URLs in output (default: failures only)
- `--ignore <glob>` / `--ignore-domain <domain>` - Ignore URLs (repeatable)
- `--allowed-status <code>` - Treat a status as successful (repeatable)
- `--[no-]cache`, `--cache-ttl <ms>` - Control raw-result caching (default: 24 hours)
- `--head-fallback-status <code>` - Status that retries with GET (repeatable)
- `--report-redirects` - Include redirect state and final destinations
- `--changed-since <revision>` - Intersect the input selection with Git changes

The cache is `${XDG_CACHE_HOME:-~/.cache}/claude-cli/url-checks.json`; missing, stale, corrupt,
or unwritable cache data is treated as a miss. HEAD falls back to GET on 400, 403, 405, and 501
by default.

#### `md validate-frontmatter <paths...>`

Validate one Markdown file or all selected files in a directory. A local JSON or YAML
Schema can be supplied with `--schema`; configured schema and shortcut rules are applied
cumulatively. Repeated `--include` and `--exclude` options override workspace selection.
Files, directories, globs, stdin, and `--changed-since` are supported.

```bash
claude-cli md validate-frontmatter docs --schema schemas/document.yml
```

#### `md check-snippets [inputs...]`

Compare fenced code blocks against the source files and regions they declare, and optionally
refresh them. A snippet is never executed; the source file is only read.

```bash
claude-cli md check-snippets docs
claude-cli md check-snippets docs --dry-run
claude-cli md check-snippets docs --write
```

A block opts in through its fence info string, so every other fence costs one substring test and
never appears in the output:

````text
```ts claude-cli:snippet=src/toc.ts#render
export function renderToc(headings: MdHeading[], ordered = false): string {
  ...
}
```
````

The source marks the region with a comment. The marker is matched inside the line, so the
comment leader does not matter and anything after the name is ignored — `//`, `#`, `--`, `/*`,
and `<!--` all work:

```ts
// claude-cli:snippet:start render
export function renderToc(...) { ... }
// claude-cli:snippet:end render
```

Omitting the `#region` selects the whole file. The language is required: a fence without one
puts the attribute where it would be silently inert, and that is reported rather than skipped.

Comparison ignores line endings, trailing horizontal whitespace, and trailing blank lines, and
nothing else — `--write` emits that same form, so writing and then checking is clean by
construction. Only the fence interior is ever rewritten, so the info string and any attribute
another toolchain owns survive byte for byte. A fence indented inside a list item is refreshed
with its indentation re-applied; one in a blockquote, one closed by end of file, and one whose
refreshed body would contain a fence-closing line are reported and left alone while the rest of
the document still refreshes.

Unlike `md fix`, a finding with no available fix — a deleted source file or a deleted region —
fails **every** mode including `--write`, because this command's job is checking. Drift alone
fails only `--check` and `--dry-run`.

Source reads are confined to the workspace root and refuse symlink escapes, non-regular files,
files over 2 MiB, and files containing NUL. Writes are confined to the directory containing the
selected documents. The mode cannot be set from project configuration.

The same engine backs `md fix --rule snippets` (opt-in) and `md audit` (on by default).

Options: `--check`, `--dry-run`, `--write`, `--include-ok`, `--include`, `--exclude`.

#### `md audit [directory]`

Run configured lint, reference, graph, frontmatter, generated-TOC, and source-linked snippet
checks as one bounded workspace operation. Graph and snippet checking are on by default.
Frontmatter and TOC checks run when configured; external URLs stay offline unless enabled
explicitly.

```bash
claude-cli md audit
claude-cli md audit docs --summary --external
claude-cli md audit docs --no-frontmatter --no-toc
claude-cli md audit docs --write-baseline .audit-baseline.json
claude-cli md audit docs --baseline .audit-baseline.json
```

A **baseline** records the findings that already exist, so an audit fails only on new ones —
enough to adopt a check on a large workspace without a flag-day cleanup or a permanently red
build. Entries are keyed on checker, workspace-relative path, and message, deliberately **not**
line number, so editing prose above a known finding does not resurface it; each entry carries a
count, so a second identical finding in the same file is still a regression. Recording is
explicit and reviewable: `--write-baseline` writes a small sorted JSON document and exits `0`,
and the two flags cannot be combined. An entry that no longer matches is reported as `stale` and
never fails the build, and a document this tool did not write is reported as a finding rather
than silently trusted. `--baseline` is configurable; `--write-baseline` is not, so a checked-in
config cannot turn the checker into a writer.

Use `--[no-]frontmatter`, `--[no-]graph`, `--[no-]toc`, and `--[no-]snippets` to select
workspace checks.
Lint selection, concurrency, include/exclude, graph entry, and URL timeout/retry options
are also available. JSON output is one object containing enabled and skipped checks,
totals, normalized findings, and graph metrics.

JSONL writes one finding/result per line followed by a summary record. SARIF output is SARIF
2.1.0 with checker rule IDs and artifact line locations. Machine payloads go to stdout on success
and stderr when findings cause exit `2`; update notices are suppressed for every machine format.
Paths are absolute unless `--paths relative` is selected.

### References

#### `md refs <file>`

List all references from a markdown file and check if targets exist.

```bash
claude-cli md refs path/to/file.md
claude-cli md refs --external --anchors --images path/to/file.md
```

Options:

- `-e, --external` - Include external URLs
- `-a, --anchors` - Include anchor-only references
- `-i, --images` - Include image references

By default, only local file link references are listed.

#### `md refs-to <file> [directory]`

Find all markdown files that reference a given file.

```bash
claude-cli md refs-to path/to/target.md
claude-cli md refs-to path/to/target.md path/to/search/dir/
```

If no directory is provided, searches from the current working directory.

With project configuration, the default is the configured workspace root. `--include` and
`--exclude` override its file selection.

#### `md links <file>`

List all links with context, grouped by type (internal, external, image, anchor).

```bash
claude-cli md links path/to/file.md
claude-cli md links --broken-only path/to/file.md
claude-cli md links --type external path/to/file.md
```

Options:

- `--broken-only` - Only show broken links
- `--type <type>` - Filter by type: `internal`, `external`, `image`, `anchor`

#### `md orphans [directory]`

Find markdown files not referenced by any other markdown file.

```bash
claude-cli md orphans path/to/docs/
claude-cli md orphans path/to/docs/ --entry README.md --ignore "archive/**"
```

Options:

- `--ignore <glob>` - Glob pattern to exclude (repeatable)
- `--entry <file>` - Entry-point file not considered orphan (repeatable)
- `--include <glob>` / `--exclude <glob>` - Override workspace selection (repeatable)

#### `md graph [directory]`

Build the selected Markdown document graph. The report includes inbound/outbound reference
counts, broken Markdown targets, dead ends, weak components, strongly connected cycles, and
reachability from `--entry` or configured entry points. Without an applicable entry point,
reachability is reported as unevaluated.

```bash
claude-cli md graph docs --entry docs/README.md
claude-cli md graph docs --output mermaid
claude-cli md graph docs --output dot
claude-cli md graph docs --focus docs/commands.md --depth 1
claude-cli md graph docs --focus docs/commands.md --output mermaid
```

`report` (the default) follows `--format`; Mermaid and DOT are deterministic raw stdout
payloads. Broken targets and unreachable documents exit `2`; informational graph metrics
do not.

`--focus` narrows the report and the diagrams to the documents within `--depth` undirected
hops, so a large workspace produces a readable neighborhood instead of an unreadable diagram.
The walk is undirected so backlinks are included. The graph is analyzed in full first and the
neighborhood projected from it, so `inbound`/`outbound` counts, components, and cycles stay
whole-workspace facts and a link leaving the radius is never reported as broken.

#### `md query <kind> [directory]`

Run focused, informational queries across the selected workspace. Query matches exit `0`;
invalid kinds or options exit `1`.

```bash
claude-cli md query links-to --target docs/guide.md#getting-started
claude-cli md query duplicates --field title
claude-cli md query duplicates --field frontmatter:id --format json
claude-cli md query unused-assets --asset-extension .png --asset-extension .svg
claude-cli md query code-blocks --lang typescript --content
claude-cli md query tasks --status pending
claude-cli md query missing-h1
claude-cli md query frontmatter-keys
```

Available kinds are `links-to`, `duplicates`, `unused-assets`, `code-blocks`, `tasks`,
`missing-h1`, and `frontmatter-keys`. Duplicate fields are `title`, `slug`, `heading-slug`, and
`frontmatter:<key>`. A title comes from string frontmatter `title`, falling back to the first
level-one heading. Asset scanning uses `assets.extensions` or repeatable
`--asset-extension` overrides.

Passing `--where`, `--select`, or `--group-by` switches to the **composable** mode, where the
kind names an entity instead:

```bash
claude-cli md query documents --where has:h1 --select file,title
claude-cli md query links --where links-to:docs/api.md --select file,line,linkText
claude-cli md query tasks --where status=pending --group-by frontmatter.owner
claude-cli md query headings --where 'depth>=2' --where text~api
```

Entities are `documents`, `headings`, `links`, `tasks`, `code-blocks`, and `frontmatter`, and
`frontmatter.<key>` is a field on every one of them. Predicates are `<field><op><value>` with
`=`, `!=`, `~`, `>`, `>=`, `<`, `<=`, or the named forms `has:<field>` and `links-to:<path>`,
negated with a leading `!`. Repeating `--where` ANDs the terms; there is no `OR`, since that
would require the precedence and quoting rules of a full expression language.

An unknown field, predicate, or operator **exits `1`** — a query never returns zero rows
because of a typo. Shortcut options such as `--status` cannot be combined with composable
ones, and predicates are deliberately not configurable so a checked-in one cannot silently
filter everyone's queries.

Without any composable option the shortcut kinds emit their historical payloads
unchanged, so `md query code-blocks` still groups by language while
`md query code-blocks --select file,line` returns flat rows.

`frontmatter-keys` inventories which top-level frontmatter keys are actually in use, with a
document count, a coverage share, and the distinct value types seen — the measurement to take
before writing a formal frontmatter schema. It is an aggregate rather than a seventh entity,
because one row per key across the workspace is not something the projection model can express.

#### `md index <action> [directory]`

Inspect and manage the persistent parsed-workspace cache.

```bash
claude-cli md index status
claude-cli md index build docs
claude-cli md index clear
```

`status` reports current, stale, and missing entries. `build` forces reparsing of the selected
Markdown files, while `clear` removes only the current workspace index. The index lives at
`${XDG_CACHE_HOME:-~/.cache}/claude-cli/workspaces/<workspace-hash>.json`. Normal commands
validate file size and modification time before reuse; missing, corrupt, incompatible, or
unwritable cache data is treated as a cache miss and never makes analysis fail.

#### `md context [seeds...]`

Assemble a reproducible context pack for an agent: ordered Markdown with source and line
provenance, plus a manifest explaining why each piece was included.

```bash
claude-cli md context docs/architecture.md --depth 2 --budget 24000
claude-cli md context docs/release.md --section "Release process" --format json
claude-cli md context --target src/cli.ts --backlinks
```

Starting from the seeds, it walks the reference graph up to `--depth` hops and emits each
reached document as flat heading sections. The partition never overlaps, so `--budget` accounts
for bytes exactly. Truncation is by whole units and the pack is a **prefix** of the order —
the first unit that would exceed the budget stops inclusion, and the rest are listed under
`omitted`. The reported token count is `bytes/4`, a size signal rather than a model tokenizer,
and it never affects what is included.

Everything is deterministic: no embeddings, no ranking model, no network. Broken references
among the included documents are reported in the payload but do not change the exit code — use
`md links` or `md audit` to fail on those.

Options: `--depth <n>` (0–6, default 1), `--section <heading>` (repeatable), `--target <path>`,
`--budget <bytes>` (0 is unlimited), `--backlinks`, `--children`, `--frontmatter`, `--include`,
`--exclude`.

#### `md diff <a> [b]`

Summarize Markdown changes by structure rather than by text.

```bash
claude-cli md diff --since origin/main docs
claude-cli md diff old.md new.md --format json
claude-cli md diff --since HEAD~1 --summary
```

Reports headings added, removed, moved, or renamed; frontmatter keys; links whose resolved
target changed; task state; code-block language and body; and tables or diagrams appearing and
disappearing. Old and new line numbers and slugs are kept on both sides, so a consumer can
repair anchors straight from the JSON.

Headings are matched conservatively — exact slug, then exact text, then position. Only the
positional pass yields a rename, and it is always flagged `heuristic: true`. String similarity
matching is deliberately not used; a wrong rename is worse than an honest add plus remove.

`--since` is the **base of the comparison**, not the `--changed-since` input filter used
elsewhere. Base content is read with `git show`; the worktree is never touched, and a revision
git cannot resolve is an error rather than "every file is new".

Exits `0` whether or not anything changed — a diff describes two states, it does not judge
them.

Options: `--since <revision>`, `--summary`, `--include`, `--exclude`.

### Document Analysis

#### `md headers <file>`

Extract all headings with their line numbers.

```bash
claude-cli md headers path/to/file.md
claude-cli md headers --max-depth 2 path/to/file.md
```

Options:

- `--max-depth <n>` - Maximum heading depth to include (1-6, default: 6)

#### `md outline <file>`

Show headings in an indented outline/tree format.

```bash
claude-cli md outline path/to/file.md
```

Options:

- `--max-depth <n>` - Maximum heading depth to include (1-6, default: 6)

#### `md toc <file>`

Generate a markdown-formatted table of contents from headings.

```bash
claude-cli md toc path/to/file.md
claude-cli md toc --min-depth 2 --ordered path/to/file.md
claude-cli md toc path/to/file.md --check
claude-cli md toc path/to/file.md --dry-run
claude-cli md toc path/to/file.md --write
```

Options:

- `--max-depth <n>` - Maximum heading depth (1-6, default: 6)
- `--min-depth <n>` - Minimum heading depth (1-6, default: 1)
- `--ordered` - Use numbered lists instead of bullets
- `--check` - Exit `2` when the marker block is missing or stale
- `--dry-run` - Print the proposed marker block without writing
- `--write` - Replace only the marker interior

Synchronization uses exactly one ordered marker pair:

```markdown
<!-- claude-cli:toc:start -->
<!-- claude-cli:toc:end -->
```

Markers inside a fenced code block are ignored, so documenting the syntax — as the block above
does — does not make a file look like it has a table of contents to synchronize.

The three synchronization modes are mutually exclusive. Writes preserve surrounding text
and the file's line-ending style, and current files are not rewritten.

#### `md stats <file>`

Show document statistics: word count, heading counts by depth, link/image counts, code block counts by language, paragraph count, and list counts.

```bash
claude-cli md stats path/to/file.md
```

#### `md code-blocks <file>`

List fenced code blocks with language, line range, and line count.

```bash
claude-cli md code-blocks path/to/file.md
claude-cli md code-blocks --lang typescript --content path/to/file.md
```

Options:

- `--lang <language>` - Filter by language
- `--content` - Include code block content in output

#### `md structure <file>`

Show a bird's-eye structural skeleton of the document — headings, code blocks, math blocks, and lists with their line ranges.

```bash
claude-cli md structure path/to/file.md
```

#### `md section <file> <heading>`

Extract the full content of a section identified by its heading text or slug (case-insensitive match).

```bash
claude-cli md section path/to/file.md "Getting Started"
claude-cli md section path/to/file.md getting-started --raw
claude-cli md section path/to/file.md "Usage" --no-children
```

Options:

- `--[no-]include-heading` - Include or exclude the heading line
- `--[no-]children` - Include or exclude nested subsections
- `--raw` - Output raw markdown only (no metadata, ignores `--format`)

#### `md frontmatter <file>`

Parse and display YAML frontmatter from a markdown file.

```bash
claude-cli md frontmatter path/to/file.md
claude-cli md frontmatter path/to/file.md --key author.name
```

Options:

- `--key <key>` - Extract a specific key (dot notation for nested keys)

#### `md tasks <file>`

Extract GFM task list items (`- [ ]` / `- [x]`) with their completion status.

```bash
claude-cli md tasks path/to/file.md
claude-cli md tasks --status pending path/to/file.md
claude-cli md tasks --summary path/to/file.md
```

Options:

- `--status <status>` - Filter by status: `done`, `pending`
- `--summary` - Show only summary counts, not individual items

#### `md tables <file>`

List or extract GFM tables with location, dimensions, and optionally content.

```bash
claude-cli md tables path/to/file.md
claude-cli md tables --index 1 --content path/to/file.md
```

Options:

- `--content` - Include table content in output
- `--index <n>` - Extract only the nth table (1-based)

### Modification

#### `md fix <inputs...>`

Turn deterministic findings into reviewable edits.

```bash
claude-cli md fix docs --check
claude-cli md fix docs --dry-run --rule toc
claude-cli md fix docs --write
```

Each fixer produces a plan — byte ranges, the exact text expected at each range, the
replacement, and the originating diagnostic — and `--write` applies the whole plan as one
transaction. The mode defaults to `--check`, which is the form that belongs in CI; `--write`
is the only mode that mutates, and it **cannot be enabled from project configuration**, so a
checked-in `.claude-cli.yml` can never turn a check into a write.

`--write` refuses entirely if any two edits overlap, any input changed after planning, or any
target resolves outside the containment root, including through a symlink. Conflicts name both
colliding rules so it is clear which `--rule` to drop. Per-file commits are atomic; the
multi-file rollback rewrites bytes best-effort and is not crash-safe.

Offsets are UTF-16 code-unit indices, not bytes, which is why `expected` is mandatory rather
than advisory — a mismatch aborts instead of corrupting a document containing emoji.

Available rules — every one below except `snippets` runs when `--rule` is omitted:

- `toc` — synchronize the content between existing `claude-cli:toc` markers. Inserting markers
  is an authoring decision, not a fix.
- `relative-links` — normalize a local link's path. A `./` prefix and percent-encoding are
  preserved rather than normalized, so a first run causes no churn. The rewritten target always
  resolves to the same absolute path, so a broken link stays broken and no fixer ever guesses
  at a destination.
- `markdownlint` — apply markdownlint's own fix for an allowlist of unambiguous whitespace
  rules (`MD009`, `MD010`, `MD012`, `MD018`–`MD021`, `MD023`, `MD027`, `MD030`, `MD037`–`MD039`,
  `MD047`). Style-preference and prose-rewriting rules are excluded.
- `snippets` — refresh a fenced block from the source region its info string declares. **Opt-in
  via `--rule snippets`**: it is the only fixer whose edits are decided by files other than the
  Markdown being fixed, and a broadly-run `md fix --write` must not silently acquire the reach
  to read arbitrary source files. See `md check-snippets` above.

Options: `--rule <name>` (repeatable), `--check`, `--dry-run`, `--write`, `--include`,
`--exclude`, `--changed-since <revision>`.

#### `md rename-file <source> <destination>`

Move a Markdown file or referenced asset within the workspace and update selected inline and
reference-style links/images. Query strings, fragments, root-relative style, and URL encoding are
preserved; outbound relative links in a moved Markdown document are recomputed.

```bash
claude-cli md rename-file docs/old.md guides/new.md --dry-run --format json
claude-cli md rename-file images/old-name.png assets/new-name.png
```

The source and destination must remain inside the workspace. The command refuses symlink or
non-file sources, existing destinations, and missing destination parents. `--include` and
`--exclude` bound the Markdown reference scan.

#### `md rename-heading <file> <old-heading> <new-heading>`

Rename a heading and update all internal anchor references that point to it.

```bash
claude-cli md rename-heading path/to/file.md "Old Name" "New Name" --dry-run
claude-cli md rename-heading path/to/file.md "Old Name" "New Name" --directory path/to/docs/
```

Options:

- `--directory <dir>` - Also update references in other markdown files within this directory
- `--include <glob>` / `--exclude <glob>` - Limit files scanned for cross-file updates
- `--dry-run` - Show what would change without modifying files

Both rename commands can modify files. `toc --write` also updates its explicitly marked block.
Use `--dry-run` before rename operations.

### Serving the engine over MCP

#### `serve <protocol>`

Expose the workspace engine to an agent host as [Model Context Protocol](https://modelcontextprotocol.io)
tools, so the host calls the engine directly instead of spawning the CLI and parsing its output.

```bash
claude-cli serve mcp --root docs
claude mcp add markdown -- claude-cli serve mcp --root docs
```

Eleven read-only tools are exposed: `list_documents`, `get_section`, `query_workspace`,
`build_context`, `inspect_graph`, `audit_markdown`, `get_outline`, `get_frontmatter`,
`list_tasks`, `list_code_blocks`, and `find_references`. Each mirrors the equivalent `md`
command's `--format json` payload, with paths relative to `--root`. Configuration is discovered
from `--root`, so a tool answers the same as that command would in the same workspace.

The server is read-only by construction rather than by flag — there is no write path in the
process, and no option adds one. Every path argument is resolved through symlinks and confined
to `--root`; traversals, escaping symlinks, and a path of `-` are all refused without echoing
the path back. The on-disk workspace index is left untouched in favor of a bounded in-memory
cache.

stdout carries JSON-RPC frames rather than a payload, so `--format` does not apply and
diagnostics go to stderr. Options: `--root <dir>`, `--config <file>`, `--no-config`,
`--max-documents <n>`, `--concurrency <n>`.

This command is the sole reason `@modelcontextprotocol/sdk` is a dependency; see
[the command page](docs/commands/serve.md#dependencies) for what that pulls in.

### Named scripts

A hook or a skill that references a script by a repository-relative path breaks the moment the
calling process changes directory — and absolute paths are not portable across checkouts. The
`scripts` toolset resolves a script by **name** instead, and runs it with its working directory
pinned to the project.

```yaml
# .claude-cli.yml
version: 1
scripts:
  gather-context:
    description: Collect repository context for the planning skill
    run: ./.claude/scripts/gather-context.sh "$@"
  lint-changed:
    exec: ["npm", "run", "lint"]
```

```bash
claude-cli scripts run gather-context          # same result from any directory
claude-cli scripts run lint-changed -- --fix   # arguments after -- are forwarded
claude-cli scripts which gather-context        # which registry wins, without running it
claude-cli scripts list                        # every name visible from here
```

Every `.claude-cli.yml` from the working directory up to the repository root is consulted, and
the nearest file that **defines the requested name** wins — so a nested package can override one
script without redeclaring the rest. Files under `node_modules` are skipped.

In `llm` and `human` formats the script's streams pass through untouched and its exit status
becomes the process's exit status, so a hook reads the real code; `--format json` captures the
streams into a payload instead. Running outside a Git repository is refused unless `--root` sets
the boundary explicitly.

This is the only command that executes anything. What makes that acceptable is that the command
is declared by name in a tracked file inside the workspace rather than discovered in content
being analyzed — the registry sits at the same trust level as a `Makefile`. See
[`scripts run`](docs/commands/scripts-run.md) for the full boundary.

### Usage reporting

Claude Code leaves a structured record of every session on disk. The `usage` toolset reads those
transcripts and reports on them — tokens, tools, skills, subagents, hooks, slash commands — so
"where is my context actually going" is a question with an answer. Nothing is sent anywhere, and
nothing outside the scan cache is written.

```bash
claude-cli usage summary                        # headline totals across every project
claude-cli usage summary --since 7d --project . # this week, this repository
claude-cli usage tokens --by day --since 30d    # spend over time
claude-cli usage tools --by server --kind mcp   # which MCP servers get used
claude-cli usage sessions --sort tokens --top 10
claude-cli usage agents                         # what delegation really costs
claude-cli usage hooks                          # hook latency and failures
```

Two things make the numbers trustworthy, and both are easy to get wrong. One API response is
written to the transcript as several lines, each carrying an identical copy of that response's
token usage, so summing the lines over-counts by roughly a factor of two; counts here
deduplicate by response. And a subagent's cost is recorded in the parent only as its _final_
message, understating the real figure several-fold, so subagent tokens are read from the
subagent's own transcript. Subagents are included by default — on a real corpus they account for
more tokens than the main thread — and `--no-subagents` excludes them.

Each transcript is reduced once and cached under `XDG_CACHE_HOME`, keyed on its size and
modification time. Transcripts are append-only, so only files that grew are ever reopened: a
first scan of a multi-gigabyte corpus takes tens of seconds and every later one is immediate.
`usage index` inspects, rebuilds, or clears that cache.

`--provider` selects the log source and `usage providers` lists what is registered. What a
provider can answer is data it declares rather than a branch in the reports, so a second
assistant's logs are one new module away from joining the same subcommands.

See [shared usage command behavior](docs/commands/usage-common.md) for the full option set, the
time-window and project-selection rules, and what the totals do and do not cover.

## Checks

- **markdownlint** - Markdown structural and formatting rules (opt-in via `--style`)
- **mermaid** - Mermaid diagram syntax validation
- **katex** - KaTeX math expression validation
- **references** - Link, anchor, and image reference validation
- **snippets** - Fenced code blocks compared against the source regions they declare

Heading anchors follow GitHub's slugging behavior, including Unicode and duplicate-heading
suffixes. Inline links and full, collapsed, and shortcut reference-style links and images
are all resolved.

The `--style` rule configuration lives in `.markdownlintrc` at the package root and ships
with the published package.

## License

MIT — see [LICENSE](LICENSE).
