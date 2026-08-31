# Project configuration schema

Markdown commands discover `.cairn.yml` by walking from the current directory toward
the filesystem root. An explicitly selected file must exist. A discovered or explicit
configuration must set `version: 1`; unknown keys are rejected at every validated level.

Paths in configuration are resolved relative to the directory containing the configuration
file. `root` defaults to that directory. Entry points and rename scan directories must stay
inside the resolved workspace root.

## Complete shape and defaults

This example contains every top-level field and every nested non-command field. Values shown
are built-in defaults unless the comment says otherwise.

```yaml
version: 1 # required when a configuration file is loaded; the only accepted value
root: . # string; workspace root relative to this file

files:
  include: ["**/*.md"] # list of strings
  exclude: [] # list of strings
  entryPoints: [] # list of paths; each must resolve inside root

assets:
  extensions: # list of strings used by the unused-assets query
    - .png
    - .jpg
    - .jpeg
    - .gif
    - .webp
    - .svg
    - .avif
    - .ico
    - .bmp
    - .pdf
    - .mp3
    - .wav
    - .ogg
    - .mp4
    - .webm
    - .mov

markdown:
  renderer: github # the only accepted value

output:
  format: llm # llm, human, json, jsonl, or sarif
  paths: absolute # absolute or relative

checks:
  mermaid: true
  katex: true
  references: true
  markdownlint: false
  frontmatter: true
  graph: true
  toc: true
  external: false
  snippets: true

frontmatter:
  schema: schemas/document.yml # optional JSON or YAML Schema path
  rules:
    required: [] # dotted field paths that must exist
    prohibited: [] # dotted field paths that must not exist
    types: {} # field path -> supported JSON type name
    allowedValues: {} # field path -> list of accepted values
    formats: {} # field path -> format string
    patterns: {} # field path -> valid JavaScript regular-expression source
    unique: [] # field paths whose values must be unique across selected files

toc:
  files: [] # workspace-relative globs/files checked by md audit

markdownlint:
  config: .markdownlintrc # optional markdownlint configuration path

urls:
  ignore: [] # URL minimatch globs
  ignoreDomains: [] # domains and their subdomains
  allowedStatuses: [] # integer HTTP statuses from 100 through 599
  cache: true
  cacheTtl: 86400000 # non-negative integer milliseconds
  headFallbackStatuses: [400, 403, 405, 501]
  reportRedirects: false

scripts: {} # named scripts for the scripts toolset; schema documented below

agent: {} # what `agent install` writes and `agent verify` checks; schema documented below

commands: {} # command-specific defaults; schema documented below
```

Omitted mappings are treated as empty mappings. Lists must contain strings except the two
HTTP-status lists. Every boolean field must be a YAML boolean, not a quoted string.

## Script registry

`scripts` is a top-level key, not a `commands.` entry. It declares named scripts for the
[`scripts` toolset](commands/scripts/run.md), which resolves a name by walking every
`.cairn.yml` from the working directory to the repository root and taking the nearest file
that defines it. Markdown commands never read this block, but they do validate it — a typo here
is an error for every command that loads configuration, rather than a surprise at run time.

```yaml
scripts:
  gather-context:
    description: Collect repository context for the planning skill
    run: ./.claude/scripts/gather-context.sh "$@"
  lint-changed:
    exec: ["npm", "run", "lint"]
    cwd: registry
```

| Key           | Type            | Description                                                        |
| ------------- | --------------- | ------------------------------------------------------------------ |
| `run`         | String          | Shell body. Forwarded arguments arrive as `$1`…`$n`.               |
| `exec`        | List of strings | Argv run with no shell. Forwarded arguments are appended.          |
| `shell`       | String          | Shell for `run`; defaults to `/bin/sh`. Rejected alongside `exec`. |
| `cwd`         | String          | `registry` (default), `invocation`, or a registry-relative path.   |
| `description` | String          | Shown by `scripts list` and `scripts which`.                       |

Exactly one of `run` and `exec` is required. Script names are lowercase and may contain
`.`, `-`, `_`, and `:`, up to 64 characters, with no leading or trailing punctuation and no
path separators. A `cwd` path is resolved against the registry directory and must stay inside
the resolution boundary.

Note the asymmetry with the rest of this file: the chain walk validates only the `scripts:`
block of each file it consults. An ancestor's malformed `urls:` block belongs to a different
project and does not break `scripts run` for a sibling package, even though `loadConfig` would
reject the same file.

## Agent installs and verification

`agent` is a top-level key, not a `commands.` entry. It has two members, which pair up:
`install` declares what a repository places into itself, and `verify` declares what
[`agent verify`](commands/agent/verify.md) asserts about the result.

Markdown commands never read either block, but they do validate both — the same rule as
`scripts`, and for the same reason. A typo here is an error for every command that loads
configuration rather than a surprise in CI.

They are separate blocks rather than one because they answer different questions — one says
what to _write_, the other asserts what is _there_ — and a flag that widened either would be a
surprise in the other. A repository may declare one without the other.

## `agent.install`

What [`agent install`](commands/agent/install.md) places into this repository, so a local
in-repo install is one command rather than one per bundle per target.

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

| Key        | Required | Description                                                              |
| ---------- | -------- | ------------------------------------------------------------------------ |
| `targets`  | Yes      | Targets every bundle is installed for. At least one.                     |
| `bundles`  | Yes      | One entry per bundle. At least one.                                      |
| `scope`    | No       | `user` or `project`. Defaults to `project`.                              |
| `into`     | No       | Install root override, relative to this file. Defaults to the profile's. |
| `link`     | No       | Symlink the rendered trees instead of copying. Defaults to `false`.      |
| `register` | No       | Edit host config to activate a marketplace install. Defaults to `false`. |

Each `bundles` entry takes a `path` and, optionally, one of `include` or `exclude` — never
both, the same rule the [marketplace spec](formats/agent-marketplace.md) uses, because their
intersection has no reading a user would predict.

| Key       | Required | Description                                                   |
| --------- | -------- | ------------------------------------------------------------- |
| `path`    | Yes      | Directory holding `agent-bundle.yaml`, relative to this file. |
| `include` | No       | Install this bundle only for these targets.                   |
| `exclude` | No       | Install this bundle for every declared target except these.   |

The block is the cross product of `bundles` and `targets`, minus each bundle's own selector.
`--target` on the command line **narrows** it and may not name a target the block omits: a
flag that could add one would let CI install for a host the repository never declared.

`path` and `into` are both resolved against the directory holding the configuration file and
must stay inside it, for the same reason `agent.verify`'s paths are — see below.

Every target declares the same project-scope merge root, so all of these land in one
destination and one manifest. They are told apart by bundle, target, profile and scope; see
[Several installs at one destination](formats/install-manifest.md#several-installs-at-one-destination).

## `agent.verify`

What [`agent verify`](commands/agent/verify.md) checks: which bundles a repository generated
its committed agent trees from, and which toolchain is allowed to have generated them.

```yaml
agent:
  verify:
    pins:
      cli: { min: "2.0.0" }
      profileSchemaVersion: "2"
      targets:
        claude-code: { min: "2026-08-02" }
    defaults:
      unmanaged: orphaned
      scope: project
    entries:
      - name: markdown
        bundle: plugins/cairn-markdown
        target: claude-code
        profile: project
        destination: .
        layout: merge
        unmanaged: strict
```

### `pins`

| Key                    | Type   | Description                                                              |
| ---------------------- | ------ | ------------------------------------------------------------------------ |
| `cli`                  | Bound  | Versions of `cairn` allowed to verify, and so to have generated, a tree. |
| `profileSchemaVersion` | String | Exact match against the running `PROFILE_SCHEMA_VERSION`.                |
| `targets`              | Map    | Per-target bound on the profile's `documentationRevision`, an ISO date.  |

A **bound** is `{ exact: … }`, or `{ min: … }` and `{ max: … }`, both inclusive. `exact` may
not be combined with either. It is not a range expression: `compareSemver` is deliberately an
ordering rather than a range grammar, and the target profiles record single bounds the same
way. Every pin is optional, and an omitted one is reported as `unpinned` with the running
value alongside, so a first run can be turned into a pin by copying what it printed.

### `defaults`

Applied to every entry that omits the key. `scope` defaults to `project`, `unmanaged` to
`orphaned`; `profile` and `layout` have no default here and fall through to the entry.

### `entries`

At least one is required, so an empty block cannot read as a pass.

| Key           | Required | Description                                                                    |
| ------------- | -------- | ------------------------------------------------------------------------------ |
| `bundle`      | Yes      | Directory holding `agent-bundle.yaml`, relative to this file.                  |
| `target`      | Yes      | Exactly one target; destinations differ per host.                              |
| `profile`     | Yes      | `plugin` or `project`. May come from `defaults`.                               |
| `destination` | No       | Root the rendered tree was placed at, relative to this file. Defaults to `.`.  |
| `name`        | No       | Identifier in findings and payload. Defaults to `<bundle>/<target>/<profile>`. |
| `scope`       | No       | `user` or `project`; selects the install location the target profile declares. |
| `layout`      | No       | `merge` (default), `plugin-dir`, or `conversion` for an `agent convert` root.  |
| `unmanaged`   | No       | `off`, `orphaned` (default), or `strict`. See the command page.                |

`bundle` and `destination` are both resolved against the directory holding the configuration
file and must stay inside it. A checked-in document describes its own repository; letting one
name an arbitrary path would make cloning a repository a way to have arbitrary directories
read.

## Frontmatter rule value types

`frontmatter.rules.types` accepts these exact values:

| Value     | Meaning                   |
| --------- | ------------------------- |
| `string`  | A string value.           |
| `number`  | Any finite numeric value. |
| `integer` | An integer numeric value. |
| `boolean` | `true` or `false`.        |
| `array`   | A YAML sequence.          |
| `object`  | A YAML mapping.           |
| `null`    | A null value.             |

`required`, `prohibited`, and all rule maps use dotted paths such as `metadata.owner`.
Schema validation and shortcut rules are cumulative when both are configured.

## Command-default schema

`commands` is a mapping keyed by an exact `md` command name. Agent commands, `scripts`
commands, and `check-update` cannot be configured here. Unknown command names and unknown
option keys are errors. Positional arguments cannot be configured.

`scripts` commands are excluded deliberately rather than by omission: a checked-in
configuration file may declare what a script _is_, under `scripts:`, but must never be able to
change how one is invoked. This is the same rule that keeps `write` out of the configurable set
for `md fix` and `md check-snippets`.

All command mappings may use the shared `format` and `paths` keys. `stdinName` is accepted
only by commands that consume a single file or stdin, as listed below.

| Command key            | Additional accepted keys                                                                                                                                                                                                                  |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `lint`                 | `style`, `mermaid`, `katex`, `references`, `stdinName`, `changedSince`, `include`, `exclude`                                                                                                                                              |
| `lint-dir`             | `style`, `summary`, `concurrency`, `mermaid`, `katex`, `references`, `include`, `exclude`, `changedSince`                                                                                                                                 |
| `refs`                 | `external`, `anchors`, `images`, `stdinName`                                                                                                                                                                                              |
| `refs-to`              | `include`, `exclude`                                                                                                                                                                                                                      |
| `headers`              | `maxDepth`, `stdinName`                                                                                                                                                                                                                   |
| `outline`              | `maxDepth`, `stdinName`                                                                                                                                                                                                                   |
| `toc`                  | `maxDepth`, `minDepth`, `ordered`, `check`, `write`, `dryRun`, `stdinName`                                                                                                                                                                |
| `graph`                | `output`, `entry`, `include`, `exclude`                                                                                                                                                                                                   |
| `validate-frontmatter` | `schema`, `include`, `exclude`, `stdinName`, `changedSince`                                                                                                                                                                               |
| `audit`                | `summary`, `external`, `frontmatter`, `graph`, `toc`, `snippets`, `style`, `mermaid`, `katex`, `references`, `concurrency`, `include`, `exclude`, `entry`, `timeout`, `retry`, `changedSince`                                             |
| `stats`                | `stdinName`                                                                                                                                                                                                                               |
| `code-blocks`          | `lang`, `content`, `stdinName`                                                                                                                                                                                                            |
| `structure`            | `stdinName`                                                                                                                                                                                                                               |
| `links`                | `brokenOnly`, `type`, `stdinName`                                                                                                                                                                                                         |
| `section`              | `includeHeading`, `children`, `raw`, `stdinName`                                                                                                                                                                                          |
| `frontmatter`          | `key`, `stdinName`                                                                                                                                                                                                                        |
| `tasks`                | `status`, `summary`, `stdinName`                                                                                                                                                                                                          |
| `tables`               | `content`, `index`, `stdinName`                                                                                                                                                                                                           |
| `check-urls`           | `timeout`, `concurrency`, `retry`, `includeOk`, `include`, `exclude`, `stdinName`, `changedSince`, `ignore`, `ignoreDomain`, `allowedStatus`, `cache`, `cacheTtl`, `headFallbackStatus`, `reportRedirects`                                |
| `check-snippets`       | `includeOk`, `include`, `exclude`. `check`, `write`, and `dryRun` are deliberately excluded so configuration can never turn this checker into a writer.                                                                                   |
| `orphans`              | `include`, `exclude`, `ignore`, `entry`                                                                                                                                                                                                   |
| `query`                | `include`, `exclude`, `target`, `field`, `lang`, `content`, `status`, `summary`, `assetExtension`. `where`, `select`, and `groupBy` are deliberately excluded: a checked-in predicate would silently filter every query in the workspace. |
| `context`              | `depth`, `section`, `target`, `budget`, `backlinks`, `children`, `frontmatter`, `include`, `exclude`                                                                                                                                      |
| `diff`                 | `since`, `summary`, `include`, `exclude`                                                                                                                                                                                                  |
| `fix`                  | `rule`, `include`, `exclude`, `changedSince`. `check`, `write`, and `dryRun` are deliberately excluded so configuration can never turn `md fix` into a writer.                                                                            |
| `index`                | `include`, `exclude`                                                                                                                                                                                                                      |
| `rename-heading`       | `directory`, `dryRun`, `include`, `exclude`                                                                                                                                                                                               |
| `rename-file`          | `dryRun`, `include`, `exclude`                                                                                                                                                                                                            |

## Command-option types and constraints

| Keys                                                                                                                                                                                                                                                                                        | Type and constraint                                                                                                                                |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `format`                                                                                                                                                                                                                                                                                    | `llm`, `human`, or `json`; `jsonl` and `sarif` are additionally allowed for `lint`, `lint-dir`, `audit`, `validate-frontmatter`, and `check-urls`. |
| `paths`                                                                                                                                                                                                                                                                                     | `absolute` or `relative`.                                                                                                                          |
| `style`, `summary`, `external`, `cache`, `reportRedirects`, `check`, `write`, `anchors`, `images`, `ordered`, `content`, `brokenOnly`, `includeHeading`, `children`, `raw`, `includeOk`, `dryRun`, `backlinks`, `mermaid`, `katex`, `references`, `frontmatter`, `graph`, `toc`, `snippets` | Boolean.                                                                                                                                           |
| `maxDepth`, `minDepth`                                                                                                                                                                                                                                                                      | Integer from 1 through 6.                                                                                                                          |
| `depth`                                                                                                                                                                                                                                                                                     | Integer from 0 through 6.                                                                                                                          |
| `timeout`, `concurrency`, `index`                                                                                                                                                                                                                                                           | Positive integer. Numeric strings are accepted.                                                                                                    |
| `cacheTtl`, `retry`, `budget`                                                                                                                                                                                                                                                               | Non-negative integer. Numeric strings are accepted.                                                                                                |
| `status`                                                                                                                                                                                                                                                                                    | `all`, `done`, or `pending`. The `tasks` CLI documents only `done` and `pending`, but configuration also accepts `all`.                            |
| `type`                                                                                                                                                                                                                                                                                      | `internal`, `external`, `image`, or `anchor`.                                                                                                      |
| `output`                                                                                                                                                                                                                                                                                    | `report`, `mermaid`, or `dot`.                                                                                                                     |
| `lang`, `key`, `directory`, `schema`, `stdinName`, `changedSince`, `target`, `field`, `since`                                                                                                                                                                                               | String.                                                                                                                                            |
| `include`, `exclude`, `ignore`, `ignoreDomain`, `entry`, `assetExtension`, `section`, `rule`                                                                                                                                                                                                | List of strings.                                                                                                                                   |
| `allowedStatus`, `headFallbackStatus`                                                                                                                                                                                                                                                       | List of integer or numeric-string HTTP statuses from 100 through 599.                                                                              |

The `commands.graph.entry`, `commands.audit.entry`, `commands.orphans.entry`, and
`files.entryPoints` paths are resolved relative to the configuration and must remain inside
`root`. `commands.rename-heading.directory` has the same containment rule.
`commands.validate-frontmatter.schema`, every `stdinName`, `frontmatter.schema`, and
`markdownlint.config` are resolved relative to the configuration file.

## Default precedence

For a command invocation, explicit CLI options override `commands.<name>`, which overrides
related top-level settings, which override built-in defaults. Repeatable list options supplied
on the CLI replace configured lists.

URL checks use this more specific chain:

1. Explicit `md check-urls` option.
2. `commands.check-urls` value.
3. Corresponding top-level `urls` value.
4. Built-in default.

## Complete example

```yaml
version: 1
root: .
files:
  include: ["docs/**/*.md", "README.md"]
  exclude: ["docs/archive/**"]
  entryPoints: ["README.md"]
assets:
  extensions: [.png, .svg, .pdf]
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
  frontmatter: true
  graph: true
  toc: true
  external: false
  snippets: true
frontmatter:
  schema: schemas/document.yml
  rules:
    required: [title, metadata.owner]
    prohibited: [draftPassword]
    types:
      title: string
      weight: integer
    allowedValues:
      status: [draft, published]
    formats:
      publishedAt: date-time
    patterns:
      slug: "^[a-z0-9-]+$"
    unique: [id, slug]
toc:
  files: [README.md, "docs/**/*.md"]
markdownlint:
  config: .markdownlintrc
urls:
  ignore: ["https://example.invalid/**"]
  ignoreDomains: [private.example.com]
  allowedStatuses: [401, 403]
  cache: true
  cacheTtl: 86400000
  headFallbackStatuses: [400, 403, 405, 501]
  reportRedirects: false
scripts:
  gather-context:
    description: Collect repository context for the planning skill
    run: ./.claude/scripts/gather-context.sh "$@"
  lint-changed:
    exec: ["npm", "run", "lint"]
agent:
  install:
    targets: [claude-code, codex]
    scope: project
    into: .
    bundles:
      - path: plugins/cairn-markdown
  verify:
    pins:
      cli: { min: "2.0.0" }
    defaults:
      scope: project
      profile: project
      layout: merge
    entries:
      - name: markdown-claude-code
        bundle: plugins/cairn-markdown
        target: claude-code
        destination: .
      - name: markdown-codex
        bundle: plugins/cairn-markdown
        target: codex
        destination: .
commands:
  lint-dir:
    summary: true
    concurrency: 4
  toc:
    minDepth: 2
    maxDepth: 4
  graph:
    output: report
    entry: [README.md]
  check-urls:
    timeout: 10000
    retry: 2
  rename-heading:
    dryRun: true
```
