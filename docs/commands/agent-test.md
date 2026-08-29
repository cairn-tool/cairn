# `agent test`

## Synopsis

```text
cairn agent test <source> [options]
```

[`agent validate`](agent-validate.md) answers "is this structurally valid?" and
[`agent doctor`](agent-doctor.md) answers "does it still conform to the target profiles?".
`agent test` answers the question only the bundle's author can ask: **does this bundle still
render what I meant it to render?** Test cases live with the bundle and assert the things a
rename, a refactor, or a revised target profile silently breaks — that a skill lands at a
particular path for `codex/project`, that `plugin.json` carries a fragment, that
`${BUNDLE_ROOT}` was substituted, that a diagnostic is or is not raised.

**Model-free by construction.** Every expectation is evaluated against the same in-memory
render [`agent convert`](agent-convert.md) would write. No model is called, no host tooling is
executed, no network request is made, and no file is written — including the golden digests,
which are reported rather than rewritten.

**Stability: experimental.** The test-file format may still change; it carries its own
`schemaVersion`, which the payload reports back as `test.schemaVersion`.

## Arguments

| Argument | Required | Description  |
| -------- | -------- | ------------ |
| `source` | Yes      | Bundle root. |

## Options

| Option                | Default  | Description                                                    |
| --------------------- | -------- | -------------------------------------------------------------- |
| `--tests <path>`      | `tests/` | Test file or directory, bundle-relative or absolute.           |
| `--target <target>`   | All      | Repeatable: `claude-code`, `codex`, `cursor`, or `all`.        |
| `--profile <profile>` | `both`   | `plugin`, `project`, or `both`.                                |
| `--case <name>`       | All      | Repeatable exact case name.                                    |
| `--strict`            | Off      | Also treat forwarded warnings, and `AB701`, as blocking.       |
| `--format <fmt>`      | `llm`    | Output as `llm`, `human`, or `json`. Shorthands: `-fh`, `-fj`. |
| `--envelope`          | Off      | Wrap `--format json` output in the versioned result envelope.  |
| `-h`, `--help`        | —        | Show help.                                                     |

`--target` and `--profile` **narrow** each case's own selection rather than widening it: a
case declaring `targets: [codex]` never runs under `--target cursor`, it is skipped and
reported as `AB701`'s quieter sibling, `AB720`.

## Where tests live

Discovery is by convention: every `*.test.yaml` or `*.test.yml` under `<bundle>/tests/`,
recursively, in a byte-sorted order. There is no manifest key, which is deliberate — it keeps
bundle `schemaVersion` 2 a strict superset of 1, and it lets a v1 or legacy bundle carry tests
too. `--tests` points at another file or directory; an explicit path that does not exist is an
error rather than "no tests found", because a typo in CI must not read as a pass.

## The test file

```yaml
schemaVersion: '1'

cases:
  - name: claude-code plugin carries the manifest and the skill
    targets: [claude-code] # optional; defaults to every target
    profiles: [plugin] # optional; defaults to plugin and project
    expect:
      paths:
        present:
          - .claude-plugin/plugin.json
          - skills/{name}/SKILL.md
        absent:
          - .claude/rules/**
      files:
        - path: skills/greet/SKILL.md
          mode: '0644'
          includes: [${CLAUDE_PLUGIN_ROOT}/assets]
          excludes: [${BUNDLE_ROOT}]
          matches: ['^---\n']
      json:
        - path: .claude-plugin/plugin.json
          contains:
            name: tested
            version: 1.2.0
      diagnostics:
        includes: [AB302]
        excludes: [AB350]
        maxSeverity: warning
      digest:
        tree: 9a2c533a3fc00f52c68cea6c022db4450087004cf80e660e80c2780b3f1e758a
        files:
          skills/greet/SKILL.md: 7db8a47da4051b8867e7f6eb4f4d8bea69cdaa9bf07898f52c05f90888288a74
```

`schemaVersion` is required, and this release reads `'1'`. It versions the assertions authors
write, independently of the package version, the bundle `schemaVersion`, the contract version,
and the target-profile version — see [the contract reference](../contract.md).

A case is evaluated once per selected `(target, profile)` pair, and **every expectation must
hold for every pair**. Declare the pairs a case is actually about rather than relying on the
defaults.

| Expectation        | Meaning                                                                                |
| ------------------ | -------------------------------------------------------------------------------------- |
| `paths.present`    | At least one rendered path matches each pattern.                                       |
| `paths.absent`     | No rendered path matches any pattern.                                                  |
| `files[].mode`     | Octal mode, spelled as in `artifacts[].mode` — quote it, or YAML reads it as a number. |
| `files[].includes` | Each string appears in the file's text.                                                |
| `files[].excludes` | No string appears in the file's text.                                                  |
| `files[].matches`  | Each JavaScript regular expression matches somewhere in the file.                      |
| `json[].contains`  | The rendered JSON document contains this fragment.                                     |
| `diagnostics`      | Codes that must be reported, codes that must not, and the worst severity allowed.      |
| `digest`           | Golden `sha256` over the whole rendered tree, and per rendered file.                   |

Paths and patterns are relative to `<target>/<profile>/`, the same root
`agent convert --output` writes under.

### Path patterns

Patterns use the grammar the target profiles already declare their outputs in, so there is
only one to learn: `{name}` matches exactly one path segment, `*` matches part of one segment,
and `**` matches any remaining suffix including nothing.
[`agent specs --format json`](agent-specs.md) publishes the declared patterns per target.

In YAML flow style a value starting with `{` opens a mapping, so write
`present: ['{name}/SKILL.md']` or use a block sequence.

### `json[].contains` is a subset match

An object matches when every expected key is present and matches; an array matches when every
expected element has a counterpart somewhere in the actual array, order-independent; anything
else must be strictly equal. That is what lets a case assert a manifest fragment without
restating the whole document, and why adding a field to a rendered manifest does not break
every test that mentions it.

### Golden digests are read, never written

The tree digest is `sha256` over a canonical serialization of the rendered artifacts: sorted
by byte comparison of path — never a locale-dependent sort — each contributing
`<path>\n<octal mode>\n<sha256 of content>\n`. It covers rendered artifacts only;
`conversion-report.json` is an `agent convert` artifact and never takes part.

`agent test` writes nothing, so a mismatch reports both values and leaves the file alone:

```text
- error AB715 [unsupported] cursor/plugin/… [digest.tree]: The rendered tree digest changed
  Remediation: Expected 9a2c53…; found 4f1b07….
```

Confirm the change was intended, then paste the reported value in. The same value is in the
payload under `test.cases[].failures[].actual`.

## Checks

| Check           | Findings         |
| --------------- | ---------------- |
| Test file shape | `AB700`          |
| Coverage        | `AB701`          |
| Path            | `AB710`, `AB711` |
| File content    | `AB712`          |
| JSON fragment   | `AB713`          |
| Diagnostics     | `AB714`          |
| Golden digest   | `AB715`          |
| Selection       | `AB720`          |

`test.checks` in the payload lists the assertion codes a run can report, the same way
[`agent audit`](agent-audit.md)'s `audit.checks` does.

## Diagnostics

| Code    | Severity | Meaning                                                      |
| ------- | -------- | ------------------------------------------------------------ |
| `AB700` | error    | A test file or one of its cases is structurally invalid.     |
| `AB701` | warning  | No test cases were found.                                    |
| `AB710` | error    | No rendered path matched a `paths.present` pattern.          |
| `AB711` | error    | A rendered path matched a `paths.absent` pattern.            |
| `AB712` | error    | A rendered file failed a mode, text, or pattern expectation. |
| `AB713` | error    | A rendered JSON document did not contain the expected value. |
| `AB714` | error    | The diagnostic codes or severity ceiling were not met.       |
| `AB715` | error    | A golden digest did not match.                               |
| `AB720` | notice   | A case was skipped by a filter or an empty selection.        |

A malformed case is reported and every other case still runs, so one typo does not hide the
rest of the suite.

## The exit rule

An unmet expectation is an `error`, so severity alone separates "a test failed" from "the
render was lossy" — unlike [`agent audit`](agent-audit.md), no per-code split is needed. The
parse and render diagnostics are forwarded, and a `warning` among them blocks only under
`--strict`; every Codex bundle carries approximate-mapping warnings that say nothing about
whether an expectation held.

`AB701` is the one warning this command mints itself, and it is deliberately non-blocking by
default: adding tests to an existing bundle should not be forced by an upgrade. `--strict` is
how CI asks "and there were tests, right?".

An unknown `--case` name exits `1` rather than selecting nothing, so a typo cannot read as a
clean run.

## Model-driven evaluation is out of scope

Behavioral evaluations that call a model are nondeterministic and can cost money, and they
should never become a requirement for ordinary validation. Nothing here calls one.

The same reasoning applies to a host's own validator. `test.native` is reserved for that
evidence and is always empty: `agent test` never spawns a process, so its result does not
depend on what happens to be installed. Each target profile does publish its validator command
through [`agent specs`](agent-specs.md) so you can run it yourself.

## Examples

```bash
# Run the tests stored with a bundle.
cairn agent test ./bundle

# One target, machine-readable.
cairn agent test ./bundle --target codex -fj | jq '.test.counts'

# One case, while writing it.
cairn agent test ./bundle --case 'the rule reaches the project profile only'

# CI gate: fail on any unmet expectation, any lossy mapping, and on a bundle with no tests.
cairn agent test ./bundle --target all --strict

# What is the digest now?
cairn agent test ./bundle -fj | jq '.test.cases[].failures[] | {expected, actual}'
```

## Exit codes

| Code | Meaning                                                                   |
| ---- | ------------------------------------------------------------------------- |
| `0`  | Every selected case passed.                                               |
| `1`  | Invocation or I/O error, including an unknown `--case` or `--tests` path. |
| `2`  | A failing case, an invalid test file, or any warning under `--strict`.    |
