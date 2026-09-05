# Contract tests and audit in full

See [`cli-basics.md`](../../../assets/cli-basics.md) for formats and exit codes.

## `agent test <source>`

| Option              | Meaning                                       |
| ------------------- | --------------------------------------------- |
| `--tests <path>`    | Override the test root; accepts a single file |
| `--target <target>` | Narrow which targets cases run for            |
| `--profile`         | Narrow which profiles                         |
| `--case <name>`     | Run one case (repeatable)                     |
| `--strict`          | Treat warnings as blocking                    |

Discovery is `<bundle>/tests/**/*.test.yaml`, by convention with **no manifest key**. An explicit
`--tests` path that does not exist **throws** — a typo there must not read as "no tests" — while a
missing default `tests/` directory simply means none.

Files are walked in byte order of their names, because discovery order decides report order.

### Case fields

Only `schemaVersion` and `cases` at the top level; only `name`, `targets`, `profiles`, and
`expect` inside a case. An unknown key is an error, not a warning.

`targets` defaults to every target; `profiles` defaults to `plugin` and `project`. Duplicate names
in one file are refused — both would be unaddressable by `--case`.

### Expectations

**`paths`** — `present` and `absent` pattern lists, relative to `<target>/<profile>/`. `{name}`
matches exactly one segment, `*` matches part of one, a trailing `**` matches any suffix including
nothing. `AB710` for a `present` pattern matching nothing; `AB711` for an `absent` one matching
something.

**`files`** — `path` (exact, not a pattern), plus optional `mode` (four-digit octal), `includes`,
`excludes`, and `matches` (regex sources tested against the whole file). An invalid regex is
rejected at parse time. All failures report `AB712` with an `assertion` field naming the check.

**`json`** — `path` plus `contains`, a **recursive subset match**: an object matches when every
expected key is present and matches; an array matches when every expected element has a
counterpart somewhere in the actual array, order-independent; anything else must be strictly
equal. Failures report `AB713`.

**`diagnostics`** — `includes`, `excludes`, and `maxSeverity`.

**`digest`** — `tree` and per-file digests. The tree digest is a value users paste, so its
serialization is contract: artifacts sorted by byte comparison of path, each contributing
`<path>\n<octal mode>\n<sha256>\n`, hashed.

There is **no `--update`**. A mismatch reports the actual value in the finding and in
`test.cases[].failures[].actual`.

The test-file `schemaVersion` is hand-owned. This release reads `"1"` and nothing else.

## `agent audit <source>`

| Option                | Meaning                                                    |
| --------------------- | ---------------------------------------------------------- |
| `--target <target>`   | Enables the rendered checks (repeatable, or `all`)         |
| `--profile <profile>` | Which profile the rendered checks cover                    |
| `--baseline <file>`   | Compare executables against a previous package `sbom.json` |
| `--strict`            | Also block on forwarded render warnings                    |
| `--format`            | `llm`, `human`, `json`, or **`sarif`**                     |

Agent SARIF goes to **stdout**, not stderr, and carries three severity levels and `properties` —
it is a separate mapper from the `md` commands' SARIF.

### The exit rule is split by origin

Almost every review finding is a warning by design, so blocking on errors alone would let a bundle
embedding a literal credential exit 0. So:

- a warning whose code is one of audit's own **always blocks**;
- a forwarded render warning blocks **only under `--strict`**.

Which is why you normally run audit without `--strict`: a Codex bundle inherently carries
approximate render warnings that say nothing about trustworthiness.

### What it reports

Hook commands and MCP server invocations verbatim, the environment and credentials they are
handed, permission grant breadth, the executable surface, and capability grants (a component
granted `shell` is flagged).

It re-emits `AB504`, `AB505`, and `AB506` rather than minting its own codes: one condition keeps
one id whichever command surfaces it, so a consumer's suppression list keeps working.

### Its limits, which belong in any report

- Static analysis only: nothing is executed, no network request is made.
- Findings are prompts for human review, **not proof that a bundle is malicious**.
- Heuristics are conservative and readable; an obfuscated command can evade them.

## `agent doctor [source]`

| Option                   | Meaning                                  |
| ------------------------ | ---------------------------------------- |
| `--output <dir>`         | Also diff a **conversion** root          |
| `--host-version <t>@<v>` | Evaluate against a specific host version |
| `--target` / `--profile` | Narrow the check                         |
| `--strict`               | Treat warnings as blocking               |

Artifacts with `origin: "native"` are skipped and reported under `doctor.overlays`. Overlay paths
are deliberately undeclared in a profile's `outputs`, because an overlay's purpose is a surface the
portable profile does not describe.
