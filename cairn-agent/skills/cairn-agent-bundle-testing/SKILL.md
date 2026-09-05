---
name: bundle-testing
description: Verify an agent bundle with the cairn agent toolset — conformance checks against target profiles, model-free contract tests, and a supply-chain audit. Use when checking that a bundle renders what it should, when a generated tree may have drifted, or before trusting or distributing someone's bundle.
---

# Verifying an agent bundle

`cairn` must be on `PATH`. Every command takes `--format llm|human|json` (`-fh`/`-fj`) and exits
`0` clean, `1` on a usage error, `2` when it found something.

Longer conventions: [`./assets/cli-basics.md`](../../assets/cli-basics.md).

## Four different questions

| Command        | Asks                                                               |
| -------------- | ------------------------------------------------------------------ |
| `agent doctor` | Does this conform to the target profiles, and has output drifted?  |
| `agent test`   | Does it render what its own tests say it should?                   |
| `agent audit`  | What should a reviewer inspect before trusting it?                 |
| `agent verify` | Does the tree committed in this repository still match the bundle? |

Run the first three in that order; `agent verify` belongs in CI rather than in the loop.
Each answers something the others do not.

## `agent doctor`

```bash
cairn agent doctor ./my-bundle --target all
cairn agent doctor ./my-bundle --target claude-code --profile plugin --output ./dist
cairn agent doctor ./my-bundle --target claude-code --host-version claude-code@2.1.0
```

Without `--output` it checks the bundle. With it, it also compares a generated tree, reporting
missing, changed, and **unmanaged** files.

**`--output` takes a conversion root, not a package or collection root.** Point it at an
`agent convert` output. A package root also holds catalogs, checksums, and the inventory, which
`doctor` would report as unmanaged.

Native overlay artifacts are skipped and reported separately under `doctor.overlays` — an overlay
is user-supplied content whose whole purpose is a surface the portable profile does not describe.

## `agent test` — model-free contract tests

```bash
cairn agent test ./my-bundle
cairn agent test ./my-bundle --target claude-code --strict
cairn agent test ./my-bundle --case explicit-skills-are-slash-commands
```

Tests live at `<bundle>/tests/**/*.test.yaml`, **by convention with no manifest key**. They are
evaluated against the same in-memory render `agent convert` would write: nothing is executed and
nothing is written.

```yaml
schemaVersion: "1"
cases:
  - name: renders-a-complete-plugin
    targets: [claude-code]
    profiles: [plugin]
    expect:
      paths:
        present: [".claude-plugin/plugin.json", "skills/{name}/**"]
        absent: [".claude/rules/**"]
      files:
        - path: skills/md-lint/SKILL.md
          mode: "0644"
          includes: ["disable-model-invocation: true"]
      json:
        - path: .claude-plugin/plugin.json
          contains: { name: my-bundle }
```

Each expectation is evaluated **once per (target, profile) pair** a case selects. An unknown key
inside a case is an error, not a warning — a misspelled assertion that is silently ignored is a
test that passes for the wrong reason.

`json.contains` is a recursive subset match, so you can assert a manifest fragment without
restating the document.

### About `digest.tree`

A case may assert a whole-tree digest. **Prefer not to.** It invalidates on every prose edit and
on any formatter pass, which turns the test file into a formatting tripwire rather than a
contract. Use `paths`, `files`, and `json` instead, and reserve digests for a bundle where byte
stability is genuinely the requirement.

There is no `--update`. A mismatch reports the actual value in the finding for you to paste back —
deliberately, because regenerating a golden automatically is how a golden stops meaning anything.

## `agent audit`

```bash
cairn agent audit ./my-bundle --target claude-code --profile plugin
cairn agent audit ./my-bundle --format sarif
cairn agent audit ./my-bundle --baseline ./previous/sbom.json
```

Reports the commands its hooks and MCP servers would run, the credentials and environment they are
handed, how broad its permission grants are, and what its executable surface looks like.

It is **explainable static analysis**: nothing is executed and no network request is made. Exit 2
means findings to review, **not proof that a bundle is malicious** — and conversely, a clean audit
is not proof that it is safe. An obfuscated command can evade conservative heuristics.

Its exit rule is split by origin, not just severity: almost every review finding is a warning by
design, so blocking on errors alone would let a bundle embedding a literal credential exit 0. A
warning whose code is audit's own blocks; a forwarded render warning blocks only under `--strict`.

That is why **`agent audit` should usually run without `--strict`** — a Codex bundle inherently
carries approximate render warnings, and they say nothing about trustworthiness.

## In CI

```bash
cairn agent validate ./my-bundle --target claude-code
cairn agent convert  ./my-bundle --target claude-code --profile plugin --output "$TMP/conv"
cairn agent doctor   ./my-bundle --target claude-code --profile plugin --output "$TMP/conv"
cairn agent test     ./my-bundle --target claude-code
cairn agent audit    ./my-bundle --target claude-code --profile plugin
cairn agent verify
```

`agent validate` takes no `--profile`.

## `agent verify`

The other four check a bundle. `agent verify` checks the _repository_: that the agent files
committed alongside the bundle are still what it renders, and that the CLI and target-profile
versions are the ones the repository pinned.

```bash
cairn agent verify                      # reads the agent.verify block; the CI shape
cairn agent verify --name my-bundle     # one entry, while iterating
```

It reads what to check from configuration rather than flags, so the pins travel with the
repository. Leave `--strict` off in CI: forwarded approximate render warnings would fail the
job, and everything that must block is already an error. Full options and the
`agent.verify` block are on the command page.

## More

The full test-file grammar, every `AB7xx` code, and audit's check lists are in
[`reference/tests.md`](reference/tests.md).
