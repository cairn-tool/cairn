---
name: bundle-reviewer
description: Reviews an agent bundle before it is published or trusted, running cairn's audit and conformance checks and returning a publish or no-publish call. Use before distributing a bundle, or before installing someone else's.
model: inherit
---

# Bundle reviewer

You review an agent bundle and return a judgment: is this safe to trust, and is it ready to
publish? You **do not edit the bundle** — you have no write access, deliberately. The value is the
call, not a set of automated changes.

## Procedure

1. Confirm `cairn` is available: `command -v cairn`. If it is missing, say so and stop.
2. `cairn agent audit <bundle> --target claude-code --profile plugin -fj`. Run it **without**
   `--strict`: a Codex bundle inherently carries approximate render warnings, and they say nothing
   about trustworthiness.
3. `cairn agent validate`, then `convert` into a temp directory, then `doctor --output` at that
   directory, then `test`.
4. Read every hook script and every MCP server command yourself. The audit reports what they
   invoke; only you can judge whether it is reasonable.
5. If it is headed for a marketplace, `cairn agent package <bundle> --target <t> --output <tmp>
--dry-run --strict` to surface publish-readiness separately.

## Judging findings

Audit findings are **prompts for human review, not proof of anything**. Exit 2 does not mean
malicious, and exit 0 does not mean safe — heuristics are conservative and readable, so an
obfuscated command can evade them. Say that when you report a clean result.

Weigh:

- **What executes.** Hook commands and MCP server invocations are the real surface. An unpinned
  `npx` specifier resolves to whatever is newest at install time.
- **What it is handed.** Environment variables, credentials, and the breadth of permission grants.
- **Whether shell access is warranted.** A component granted `shell` is flagged; the question is
  whether its job needs it.
- **Executables outside `hooks/`, `scripts/`, and `bin/`**, which is where a script belongs.

## What to report

- **A verdict in one line**: publish, publish with changes, or do not.
- **Findings ranked by consequence**, each with the file and what would actually go wrong.
- **What you inspected by hand** beyond the audit, so the caller knows the coverage.
- **The limits of the review**: static analysis only, nothing executed, no network request made.

Do not pad the report with clean checks. Say what needs attention and what you would ship.

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

# Packaging, installing, and publishing

`cairn` must be on `PATH`. Every command takes `--format llm|human|json` (`-fh`/`-fj`) and exits
`0` clean, `1` on a usage error, `2` when it found something.

Longer conventions: [`./assets/cli-basics.md`](../../assets/cli-basics.md).

**Nothing here contacts the network or publishes anything.** These commands produce trees and
checklists; taking an irreversible external action is left to you.

## One bundle: `agent package`

```bash
cairn agent package ./my-bundle --target all --output ./release --archive
cairn agent package ./my-bundle --target codex --output ./release --check --strict
cairn agent package ./my-bundle --target all --output ./release --from-dist ./converted
```

Renders the bundle itself rather than reading an existing tree, so a package can never certify
output that has drifted. `--from-dist` answers the other question — "did CI build what this bundle
produces?" — by rendering in memory and comparing.

Produces the payload plus a marketplace catalog, `sha256sum`-compatible checksums, a file
inventory, and optional byte-reproducible archives.

## Several bundles: `agent marketplace`

`agent package` emits **one catalog per bundle**. Five bundles packaged individually are five
marketplaces a user has to add one at a time. A collection is one:

```yaml
# agent-marketplace.yaml
schemaVersion: "1"
name: my-tools
version: 1.0.0
description: My toolset, as plugins.
owner:
  name: Your Name
targets: [claude-code]
bundles:
  - path: plugins/first
  - path: plugins/second
    exclude: [codex]
```

```bash
cairn agent marketplace agent-marketplace.yaml --output ./dist-plugins
cairn agent marketplace agent-marketplace.yaml --install --register
cairn agent marketplace agent-marketplace.yaml --output ./dist --check --strict
```

`include:`/`exclude:` on a bundle select which targets it is built for. `--target` **narrows** the
spec's targets and may not add to them — the spec is the record of what a collection is for.

The document's `name`, `description`, and `owner` come from the spec; each entry's `author`,
`category`, and `license` still come from its own bundle. Entry `source` paths are relative, so a
published tree names no owner, repo, or branch.

## Installing locally

```bash
cairn agent install ./my-bundle --target cursor --scope user
cairn agent install ./my-bundle --target claude-code --scope user --register
cairn agent install ./my-bundle --target cursor --scope user --link
cairn agent installed
cairn agent uninstall my-bundle --target cursor
```

### One destination may hold several installs

`--target` is repeatable, and every target's project scope resolves to the same merge root, so
a repository can install for two hosts — or install two bundles — into one directory:

```bash
cairn agent install ./my-bundle --target claude-code --target codex --scope project --into .
```

Installs are told apart by `(bundle, target, profile, scope)` in the one `.cairn-install.json`,
so reinstalling one prunes only its own stale files and uninstalling one leaves the other.
**A run is planned in full before anything is written**: if any plan is blocked, nothing is
written for any of them.

Two installs writing byte-identical content to one path — a bundle's assets, which every
target places at the destination root — is co-ownership. Writing _different_ content there is
`AB808`, which is reachable: Antigravity and Codex both declare `.agents/skills/<name>/`.

### A repository can declare its own installs

Put an `agent.install` block in `.cairn.yml`, beside the `agent.verify` block `agent verify`
reads, and the whole in-repo install is one command:

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

```bash
cairn agent install                       # walks up for .cairn.yml
cairn agent install --config other.yml    # names one explicitly
```

`--target` there **narrows** the block and may not name a target it omits, the same rule
`agent marketplace` uses. Prefer this over `agent convert` plus a copy: a copied tree has no
install manifest, so a file the bundle stops rendering is never flagged.

**`--register` is the only flag that edits host config**, and only Claude Code's marketplace
layout needs it. Without it the tree is still written and the exact required edit is reported as
`AB805`.

Registering is necessary but not sufficient: Claude Code validates the catalog those keys point
at and, if it fails, drops the marketplace **and prunes the settings entries** — so a bad catalog
looks exactly like a `--register` that never ran. Verify with
`claude plugin validate ~/.claude/plugins/marketplaces/<name>`.

`--link` materializes the render once under the bundle's `.install/` tree and symlinks the host
path at it, so edits are live. Use it while writing content.

### Bundle install and collection install differ

`agent install --register` keys the marketplace on the **bundle** name, so installing five bundles
gives five marketplaces. `agent marketplace --install --register` registers one marketplace
enabling every plugin. Do not do both for the same plugin: you get two offers of it under
different keys and a doubled skill list.

## `AB500` is the failure to expect

Claude Code refuses a catalog with no top-level `owner`, sourced from `marketplace.publisher` —
and `agent init` scaffolds `publisher.name: ""`, which validates cleanly. So a bundle can pass
`agent validate` for weeks and fail the moment you package it.

Codex additionally **requires** `marketplace.icon`. A bundle without one packages for Claude Code
and Cursor and fails for Codex.

Fix the manifest; do not work around the catalog.

## Deterministic archives

`--archive` writes ustar `.tar.gz` files built to be byte-identical across runs and machines:
zeroed mtimes and ownership, normalized modes, entries sorted by **byte** comparison rather than
locale, and a zeroed gzip header. A path that will not fit a ustar header is refused rather than
escalated to a PAX record.

## More

Catalog field tables, install locations per target, and every `AB5xx`/`AB8xx`/`AB9xx` code are in
[`reference/marketplace.md`](reference/marketplace.md).
