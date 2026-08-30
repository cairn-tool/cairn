# Conversion output

What [`agent convert`](../commands/agent/convert.md) writes, and what
[`agent import`](../commands/agent/import.md) writes going the other way.

## The output tree

Every conversion uses the same deterministic layout, whichever targets and profiles were
selected:

```text
<output>/
  claude-code/{plugin,project}/
  codex/{plugin,project}/
  cursor/{plugin,project}/
  antigravity/{plugin,project}/
  opencode/{plugin,project}/
  conversion-report.json
```

Each `<target>/<profile>/` root is **managed**: a write replaces its contents atomically, and
`--check` and `agent doctor --output` treat any file inside one that no artifact accounts for
as drift. `conversion-report.json` is a loose file at the output root, outside every managed
root.

What lands inside each root is entirely determined by that target's declared output patterns —
see [Target profile format](target-profile.md#outputs) and the per-target pages under
[Providers](../providers.md).

## `conversion-report.json`

The full `agent convert` result, plus provenance, written at the output root.

```jsonc
{
  "command": "convert",
  "ok": true,
  "source": "/abs/path/to/bundle",
  "targets": ["claude-code", "codex", "cursor", "antigravity", "opencode"],
  "profiles": ["plugin", "project"],
  "artifacts": [
    { "path": "claude-code/plugin/.claude-plugin/plugin.json", "bytes": 214, "mode": "0644" },
    { "path": "claude-code/plugin/hooks/guard.sh", "bytes": 48, "mode": "0755" },
    {
      "path": "cursor/plugin/.cursor/statusline.json",
      "bytes": 31,
      "mode": "0644",
      "origin": "native",
    },
  ],
  "diagnostics": [
    {
      "code": "AB302",
      "severity": "warning",
      "quality": "approximate",
      "message": "Codex has no portable $ARGUMENTS substitution; emitted explanatory text",
      "target": "codex",
      "profile": "plugin",
      "path": "…",
    },
  ],
  "dryRun": false,
  "check": false,
  "generator": { "name": "@cairn-tool/cairn", "version": "1.12.0" },
  "profileSchemaVersion": "2",
  "targetProfiles": {
    "claude-code": { "documentationRevision": "2026-08-02" },
    "codex": { "documentationRevision": "2026-08-02" },
    "cursor": { "documentationRevision": "2026-08-02" },
    "antigravity": { "documentationRevision": "2026-08-29" },
    "opencode": { "documentationRevision": "2026-08-29" },
  },
}
```

### `artifacts[].origin`

**Emitted only when the value is `"native"`.** Always emitting it would change
`conversion-report.json` and `agent convert -fj` bytes for every bundle that has no overlay,
which is most of them. A consumer reads an absent `origin` as `"portable"`.

### `mode`

An octal string with a leading zero, e.g. `"0644"` or `"0755"`. The same spelling is used by
`sbom.json`, the install manifest, and test-file `mode` expectations.

### Provenance

`generator`, `profileSchemaVersion`, and `targetProfiles` exist so `agent doctor` can tell a
tree generated against an older target profile from a current one. They are why the report
itself is **compared by existence only**: it embeds the generator version, so byte-comparing it
would report every tree as stale after any CLI upgrade — and it is derived from artifacts that
are already compared byte for byte.

### The in-tree report always says `dryRun: false, check: false`

The persisted artifact describes the **tree**, so those flags are pinned. It also omits
`stale`, because the artifact list is serialized before `--check` has run.

## `--report <path>`

The same document, written to an arbitrary path, so CI can keep the report without keeping the
rendered tree. It differs in exactly two ways, both toward honesty:

- `dryRun` and `check` carry their **real** values, because this describes a _run_ rather than
  the tree it sits beside
- `stale` is present, which the in-tree artifact misses only because of serialization order

It is written in **every** mode — including `--dry-run`, `--check`, and a strict failure —
because an explicitly named path is a request for diagnostic output, and a failing run is when
it matters most.

It is never listed in `artifacts` and never compared by `--check`. Adding it to `artifacts`
would change `conversion-report.json`'s own bytes, and since that file is compared by existence
only, the divergence would be silent.

It is refused inside the source tree or inside the output directory, where an unmanaged file
would itself read as drift.

## Write semantics

| Condition                                   | Artifacts written | Report written      |
| ------------------------------------------- | ----------------- | ------------------- |
| clean run                                   | yes               | yes                 |
| non-strict run with approximate mappings    | yes               | yes                 |
| hard validation error (`severity: "error"`) | no                | only via `--report` |
| `--strict` with any non-`exact` mapping     | no                | only via `--report` |
| `--dry-run`                                 | no                | only via `--report` |
| `--check`                                   | no                | only via `--report` |

A non-strict conversion writes usable artifacts and **still exits `2`** when there are
compatibility losses to report. An existing non-empty selected destination requires `--force`;
conversion never prompts.

## Exit codes

| Code | Meaning                                                         |
| ---- | --------------------------------------------------------------- |
| `0`  | the requested operation was lossless                            |
| `1`  | invocation, path, or I/O error                                  |
| `2`  | validation, compatibility, strict-mode, or stale-check findings |

All `agent` output — including the failure result for an invocation error — goes to **stdout**.
That is a recorded deviation from the general "findings to stderr" rule; see
[the contract](../contract.md#streams).

## `import-report.json`

[`agent import`](../commands/agent/import.md) is the inverse of conversion: it turns an
existing native plugin or project into a portable bundle, detecting the layout from the same
target profiles the renderer uses.

Every input file gets a provenance row, so nothing is silently dropped.

```jsonc
{
  "from": {
    "target": "claude-code",
    "profile": "plugin",
    "requested": "auto",
    "confidence": "high",
  },
  "merge": "…",
  "files": [
    {
      "source": "skills/prepare-release/SKILL.md",
      "destination": "skills/prepare-release/SKILL.md",
      "layer": "portable",
      "fidelity": "exact",
    },
    {
      "source": ".claude/statusline.json",
      "destination": "native/claude-code/project/.claude/statusline.json",
      "layer": "native",
      "fidelity": "exact",
      "note": "no portable equivalent",
    },
    { "source": "…", "destination": null, "layer": "dropped", "fidelity": "unsupported" },
  ],
  "counts": { "portable": 12, "native": 3, "manifest": 1, "dropped": 0 },
}
```

| Field         | Meaning                                                       |
| ------------- | ------------------------------------------------------------- |
| `source`      | POSIX path relative to the import source root                 |
| `destination` | POSIX path relative to the new bundle root, `null` if dropped |
| `layer`       | `portable`, `native`, `manifest`, or `dropped`                |
| `fidelity`    | `exact`, `approximate`, or `unsupported`                      |
| `note`        | why, when it is not obvious                                   |

Untranslatable pieces are preserved under `native/<target>/` rather than discarded — which is
what makes the round trip safe, and what the `native` count reports.

Like the conversion report, `import-report.json` is compared **by existence only** when
checking a previously imported tree, for the same reason: it embeds the generator version.

## Related

- [`agent convert`](../commands/agent/convert.md), [`agent import`](../commands/agent/import.md),
  [`agent doctor`](../commands/agent/doctor.md)
- [Agent bundle format](agent-bundle.md) — the input side
- [Package format](package.md) — what `agent package` adds on top of a render
- [Machine-readable result contract](../contract.md) — the `agent-result` schema
