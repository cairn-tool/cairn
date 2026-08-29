# Audit baselines

Two commands accept a baseline, and they are different documents solving different problems.

| Command                                     | Baseline document      | Question it answers                        |
| ------------------------------------------- | ---------------------- | ------------------------------------------ |
| [`md audit`](../commands/md/audit.md)       | its own baseline JSON  | which existing findings are already known? |
| [`agent audit`](../commands/agent/audit.md) | a previous `sbom.json` | what changed in the executable surface?    |

Both refuse to guess at a foreign document, and both report that refusal as a finding rather
than silently doing nothing useful.

## `md audit` baseline

A record of the findings a workspace already has, so CI can block **new** ones without
requiring the backlog to be fixed first.

`--write-baseline` produces it; `--baseline` applies it.

```jsonc
{
  "baselineFormat": "cairn-md-audit-baseline",
  "version": "1",
  "generator": { "name": "@bstockus/cairn", "version": "1.12.0" },
  "entries": [
    { "checker": "toc", "file": "docs/a.md", "message": "Table of contents is stale", "count": 1 },
  ],
}
```

| Field            | Meaning                                                            |
| ---------------- | ------------------------------------------------------------------ |
| `baselineFormat` | the discriminator; `claude-cli-md-audit-baseline` is also accepted |
| `version`        | the structure version of this document, not the package version    |
| `generator`      | which build wrote it                                               |
| `entries`        | the recorded findings                                              |

### The finding identity excludes the line number

An entry is keyed on `checker`, `file`, and `message` — joined by NUL, because a NUL cannot
occur in any of them and a space can.

**The line number is deliberately not part of it.** A finding does not become a different
finding because unrelated prose was inserted above it, and a line-sensitive key would turn every
reflow into a wall of regressions and force a baseline refresh on commits that fixed nothing.

The cost is that two identical findings in one file collapse to one entry, so `count` carries
the multiplicity. Findings are consumed in order: with a `count` of one and two matching
findings, the first is suppressed and the second is reported.

### Paths are workspace-relative

`/`-separated, relative to the workspace root. A baseline holding absolute paths would match
nothing after a checkout into a different directory, which is the normal case in CI.

### Entries are sorted by byte comparison

By `checker`, then `file`, then `message` — never `localeCompare`, so the document does not
depend on the ICU build of the runner that wrote it.

### Failure modes

| Condition                      | Result                                                |
| ------------------------------ | ----------------------------------------------------- |
| file missing or unparseable    | throws — a `--baseline` typo must not read as "clean" |
| not a baseline document at all | throws                                                |
| **foreign** `baselineFormat`   | reported as `foreign`; nothing is suppressed          |
| entry that matched nothing     | reported as `stale`; never blocking                   |

A foreign document is a finding rather than a throw because guessing at another tool's schema
would produce suppression nobody can trust.

## `agent audit` baseline

Not a suppression list. It is the **previous release's package inventory**, and comparing
against it answers "what can run, and did it change since we last shipped?"

`--baseline <sbom.json>` reads a document `agent package` wrote:

```jsonc
{
  "bomFormat": "cairn-inventory",
  "generator": { "name": "@bstockus/cairn", "version": "1.11.0" },
  "subject": { "name": "release-helper", "version": "0.9.0" },
  "components": [
    {
      "path": "claude-code/plugin/hooks/guard.sh",
      "type": "script",
      "sha256": "…",
      "bytes": 48,
      "mode": "0755",
      "origin": "portable",
    },
  ],
}
```

`claude-cli-inventory` is also accepted as the discriminator. The document shape is documented
in full under [Package format](package.md#sbomjson).

### Scope is the executable surface

The comparison narrows to baseline components typed `script` or `executable`, plus anything on
the current side that carries an execute bit.

That is exactly the question being asked, and it drops the noise: a reworded document or a
regenerated manifest is not a change in what a bundle can _do_.

Because the current side has to be classified by the same rule the baseline was, `classify` is
exported from the packager and shared — the two cannot drift into disagreeing about what
counts as a script.

### Report

```jsonc
{
  "path": "…/sbom.json",
  "subject": { "name": "release-helper", "version": "0.9.0" },
  "generator": { "name": "@bstockus/cairn", "version": "1.11.0" },
  "compared": 4,
  "added": ["…"],
  "removed": ["…"],
  "changed": ["…"],
  "modeChanged": [{ "path": "…", "from": "0644", "to": "0755" }],
}
```

All four lists are sorted by byte comparison. `modeChanged` is separate from `changed` because
a file gaining an execute bit is a different kind of event from its contents changing, and it is
the one a reviewer most wants surfaced.

### Failure modes

`AB650`–`AB653` cover the drift findings. `AB654` is the foreign-document case: a baseline
whose `bomFormat` is neither spelling this tool writes is reported rather than parsed, because
guessing at another tool's schema would produce drift reports nobody can trust.

A missing or unparseable file throws, matching how `agent package --from-dist` and
`agent doctor --output` treat a path that is not there.

## Why `agent audit`'s exit rule is split by origin

Not a baseline concern strictly, but it is where the two interact. Almost every review finding
is a `warning` by design, so blocking on errors alone would let a bundle embedding a literal
credential exit `0`. But audit also forwards render diagnostics, and every Codex bundle carries
approximate warnings.

So: a warning whose code is in `AUDIT_CODES` blocks; a **forwarded** one blocks only under
`--strict`.

Adding a check means adding its code to `SOURCE_CHECKS`, `RENDERED_CHECKS`, or
`BASELINE_CHECKS`, or it will neither gate CI nor appear in `audit.checks` — which is what
tells a consumer "clean" from "not checked".

## Related

- [`md audit`](../commands/md/audit.md), [`agent audit`](../commands/agent/audit.md)
- [Package format](package.md) — where `sbom.json` comes from
- [Diagnostics](diagnostics.md)
