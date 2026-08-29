# Bundle contract test format

The assertion format [`agent test`](../commands/agent/test.md) reads. A case asserts what a
bundle **actually renders** for a target and profile, so a rename, a refactor, or a revised
target profile cannot change the output silently.

It is model-free by construction: expectations are evaluated against the same in-memory render
`agent convert` would write, nothing is executed, and nothing is written — including the golden
digests, which are reported for you to paste back rather than rewritten in place.

## Discovery

`<bundle>/tests/**/*.test.yaml` (or `.test.yml`), **by convention, with no manifest key**.

That is deliberate. A manifest key would end schema 2's "schema 1 plus `marketplace:` and
`native:`, nothing else" property, and would lock the feature out of v1 and legacy bundles,
which can carry tests today.

`--tests <path>` overrides the root and accepts a single file. An explicit path that does not
exist **throws**, because a typo there must not read as "no tests"; a missing default `tests/`
directory simply means none.

Files are walked in byte order of their names, never `localeCompare`, because discovery order
decides the order cases are reported in.

The test directory is invisible to the bundle parser — `assets` is read from its own configured
root — but `buildSourceInventory` walks the whole bundle root, so test files **do** enter
`agent audit`'s inventory. That is deliberate: they are bundle files.

## Schema version

`schemaVersion` is a **hand-owned** version, the fourth in this project, and it versions the
assertions authors write. This release reads `"1"` and nothing else; an unsupported value is an
`AB700` finding on that file.

## Document shape

```yaml
schemaVersion: "1"
cases:
  - name: plugin-manifest-is-complete
    targets: [claude-code]
    profiles: [plugin]
    expect:
      paths:
        present:
          - .claude-plugin/plugin.json
          - skills/{name}/**
        absent:
          - .claude/rules/**
      files:
        - path: skills/prepare-release/SKILL.md
          mode: "0644"
          includes: ["## Steps"]
          excludes: ["TODO"]
          matches: ["^---\\nname: prepare-release$"]
      json:
        - path: .claude-plugin/plugin.json
          contains:
            name: release-helper
            skills: ["./skills"]
      diagnostics:
        includes: ["AB302"]
        excludes: ["AB320"]
        maxSeverity: warning
      digest:
        tree: 9f2b…
        files:
          .claude-plugin/plugin.json: 41ad…
```

Only `schemaVersion` and `cases` are allowed at the top level, and only `name`, `targets`,
`profiles`, and `expect` inside a case. An unknown key is an error, not a warning — a
misspelled assertion that is silently ignored is a test that passes for the wrong reason.

## Case fields

| Field      | Required | Meaning                                               |
| ---------- | -------- | ----------------------------------------------------- |
| `name`     | yes      | how `--case` selects it and how a failure is reported |
| `targets`  | no       | defaults to every target; unknown values are an error |
| `profiles` | no       | defaults to `plugin` and `project`                    |
| `expect`   | yes      | the expectations, below                               |

Duplicate names inside one file are refused: both would be unaddressable by `--case` and
indistinguishable in a failure report. Values are deduplicated.

Every expectation is evaluated **once per (target, profile) pair** the case selects.

## Expectations

### `paths`

```yaml
paths:
  present: [".claude-plugin/plugin.json", "skills/{name}/**"]
  absent: [".claude/rules/**"]
```

Patterns use the same grammar as a target profile's output patterns: `{name}` matches exactly
one path segment, `*` matches part of one segment, and a trailing `**` matches any remaining
suffix including nothing. Paths are relative to `<target>/<profile>/`.

Failures: `AB710` for a `present` pattern that matches nothing, `AB711` for an `absent` pattern
that matches something.

### `files`

```yaml
files:
  - path: agents/reviewer.md
    mode: "0644"
    includes: ["model: sonnet"]
    excludes: ["${ARGUMENTS}"]
    matches: ["^---\\n"]
```

| Key        | Meaning                                                              |
| ---------- | -------------------------------------------------------------------- |
| `path`     | required; an exact rendered path, not a pattern                      |
| `mode`     | four-digit octal, e.g. `"0644"` — validated at parse time            |
| `includes` | substrings that must be present                                      |
| `excludes` | substrings that must be absent                                       |
| `matches`  | JavaScript regular-expression sources, tested against the whole file |

An invalid regular expression is rejected when the file is parsed, not when the case runs.

All file failures report `AB712`, with the `assertion` field naming which check failed
(`files[0].includes`, `files[0].mode`, and so on).

### `json`

```yaml
json:
  - path: .claude-plugin/plugin.json
    contains:
      name: release-helper
      skills: ["./skills"]
```

`contains` is a **recursive subset match**, which is what lets you assert a manifest fragment
without restating the whole document:

- an object matches when every expected key is present and its value matches
- an array matches when every expected element has a counterpart **somewhere** in the actual
  array, order-independent
- anything else must be strictly equal

Failures report `AB713`: the file was not rendered, was not valid JSON, or did not contain the
expected value at a named key.

### `diagnostics`

```yaml
diagnostics:
  includes: ["AB302"]
  excludes: ["AB320"]
  maxSeverity: warning
```

| Key           | Meaning                                                     |
| ------------- | ----------------------------------------------------------- |
| `includes`    | diagnostic codes the render **must** report                 |
| `excludes`    | codes it must **not** report                                |
| `maxSeverity` | the worst severity allowed: `notice`, `warning`, or `error` |

`maxSeverity` absent means unconstrained. Failures report `AB714`.

Asserting an expected approximation is the point here: a Codex bundle that legitimately reports
`AB302` should say so, and should fail if that ever silently stops happening.

### `digest`

```yaml
digest:
  tree: 9f2b…
  files:
    .claude-plugin/plugin.json: 41ad…
```

`tree` is a golden digest over every rendered artifact for that target and profile; `files`
holds one per rendered path. Failures report `AB715`.

Comparison is case-insensitive and trims surrounding whitespace, so a digest pasted from a
terminal works.

## The tree digest serialization is contract

**Authors paste this value into a file, so its computation is a published guarantee.**
Changing the order, the separators, or what is included invalidates every golden digest in
every bundle in the world.

Artifacts are sorted by **byte comparison of path**, never `localeCompare`. Each contributes:

```text
<path>\n<octal mode>\n<sha256 of content>\n
```

Those strings are concatenated in order and the result is SHA-256 hashed. The octal mode is
spelled as in `artifacts[].mode`, e.g. `0644`.

A per-file digest is simply the SHA-256 of that file's content.

**There is no `--update`.** The command never writes, so a mismatch reports the actual value in
the finding and in `test.cases[].failures[].actual`, for you to paste back deliberately.

## Failures and skips

| Code    | Meaning                               |
| ------- | ------------------------------------- |
| `AB700` | the test file is structurally invalid |
| `AB701` | a run-level problem                   |
| `AB710` | `paths.present` matched nothing       |
| `AB711` | `paths.absent` matched something      |
| `AB712` | a `files` expectation failed          |
| `AB713` | a `json` expectation failed           |
| `AB714` | a `diagnostics` expectation failed    |
| `AB715` | a `digest` expectation failed         |
| `AB720` | a case was skipped, with the reason   |

A structural problem is an `AB700` **finding**, not a throw, so one malformed case does not
hide every other case in the bundle. A file whose YAML will not parse at all is a different
kind of failure and is raised as an error.

## Exit behavior

`agent test` reports approximations as the expected outcome rather than as defects, so it does
not use the default `hasFindings` rule. It decides its own exit: findings mean `2`, and
`--strict` widens what counts.

## Related

- [`agent test`](../commands/agent/test.md)
- [Agent bundle format](agent-bundle.md)
- [Target profile format](target-profile.md) — where the output patterns come from
- [Diagnostics](diagnostics.md)
