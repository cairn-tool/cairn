# Diagnostics

Four finding shapes exist in this project, for four different kinds of check, and they are not
interchangeable.

| Shape                  | Produced by              | Carries                                                       |
| ---------------------- | ------------------------ | ------------------------------------------------------------- |
| `Issue`                | every `md` checker       | file, line, checker, message                                  |
| `AgentDiagnostic`      | every `agent` command    | a stable `AB###` code, severity, quality, and location        |
| `ConversionDiagnostic` | every `jira adf` command | a stable `AD###` code, severity, quality, and location        |
| `PdfDiagnostic`        | every `pdf` command      | a stable `AP###` code, severity, quality, page, and construct |

## `Issue`

```ts
interface Issue {
  file: string;
  line: number;
  checker: string;
  message: string;
}
```

**An `Issue` carries no severity.** Everything a `md` checker reports is a finding of equal
weight; whether it blocks is decided by the command's exit rule, not per finding. That is why
the `md` SARIF writer hardcodes `level: "error"` — it is contract, not an oversight.

`checker` names the check (`toc`, `ref/link`, `katex`, `mermaid`, `style`, …) and is what a
[baseline](audit-baseline.md) keys on together with the file and message.

The published schemas are `issue` and `issue-list`.

## `AgentDiagnostic`

```ts
interface AgentDiagnostic {
  code: string; // AB###
  severity: "notice" | "warning" | "error";
  message: string;
  quality: "exact" | "approximate" | "unsupported";
  component?: string;
  path?: string;
  target?: AgentTarget;
  profile?: AgentProfile;
  remediation?: string;
}
```

### Severity is derived from quality, then overridden

The constructor maps `quality` to a default severity:

| Quality       | Default severity |
| ------------- | ---------------- |
| `exact`       | `notice`         |
| `approximate` | `warning`        |
| `unsupported` | `warning`        |

A caller then raises it to `error` for a hard validation failure. So `unsupported` alone is a
warning — an unsupported _mapping_ is a reported loss, not a broken bundle — while a malformed
manifest field is an error even though its quality is also `unsupported`.

`path` is **absolute** when the diagnostic came from the parser and **output-relative** when it
came from the renderer. Consumers that need one or the other normalize; the SARIF writer does.

### Codes are stable identifiers

`AB###` for an agent bundle, `AD###` for an ADF conversion, and `AP###` for PDF reading, and a code
is never reused for a different condition. One condition keeps one ID
whichever command surfaces it — which is why `agent audit` **re-emits** `AB504`, `AB505`, and
`AB506` from the packager rather than minting its own. Doing otherwise breaks a consumer's
suppression list.

Every target profile declares which codes it may emit per feature, and `validateProfile`
rejects a malformed one.

## `ConversionDiagnostic`

```ts
interface ConversionDiagnostic {
  code: string; // AD###
  severity: "notice" | "warning" | "error";
  message: string;
  quality: "exact" | "approximate" | "unsupported";
  node?: string;
  location?: string;
  remediation?: string;
}
```

Emitted by every `jira adf` subcommand. `code`, `severity`, `message`, and `quality` are always
present; `node` names the ADF node or mark type the finding concerns, `location` is the
slash-joined trail of ancestor types, and `remediation` appears where there is something to do
about it.

`quality` means what it means for an `AgentDiagnostic`, and severity is derived from it by the
same rule — which is why the mapping lives in `src/mapping-quality.ts` rather than in either
family, so the two cannot drift. A caller that means "refuse" sets `error` explicitly. So an
`AD1xx` code is an `error` when the input is invalid, while an `AD2xx` or `AD3xx` code describing
a lossy mapping is a `warning`.

Findings are deduplicated by code, node, and location. A table with two hundred flattened cells
reports the condition once per cell position rather than burying every other finding under it.

The published schema is `adf-result`.

## `PdfDiagnostic`

```ts
interface PdfDiagnostic {
  code: string; // AP###
  severity: "notice" | "warning" | "error";
  message: string;
  quality: "exact" | "approximate" | "unsupported";
  page?: number; // 1-based, when the finding concerns one page
  construct?: string; // a structure role, a filter name, a font name
  remediation?: string;
}
```

Structurally a `ConversionDiagnostic` with `node` and `location` replaced by `page` and
`construct`. A PDF finding is positioned by page rather than by a node ancestry trail, and putting a
page number into a field documented as "slash-joined ancestor node types" would be worse than a
fourth shape. `quality` and the quality-to-severity rule come from `src/mapping-quality.ts`, shared
with the other two conversion families so the three cannot drift.

Findings are deduplicated on code, construct, and page, and ordered by code, then **numerically** by
page, then by byte comparison of the construct. The numeric page ordering is the one place this
differs from the ADF sink: a bytewise sort puts page 10 before page 2, and a reader scanning a
300-page document's findings would be reading them out of order.

The published schema is `pdf-result`.

## Code ranges

Every code, with its severity and meaning, is in
[diagnostic codes](diagnostic-codes.md). This table is the map; that page is the reference.

`agent verify` re-emits `AB402`, `AB403`, `AB404`, and `AB806` rather than minting codes of its
own, on the same rule `agent audit` follows for `AB504`–`AB506`: one condition keeps one
identifier whichever command surfaces it, or a consumer's suppression list breaks.

| Range           | Emitted by                     | Concerns                                                                             |
| --------------- | ------------------------------ | ------------------------------------------------------------------------------------ |
| `AB000`         | `src/commands/agent.ts`        | invocation failure                                                                   |
| `AB001`         | bundle parser                  | legacy Claude Code plugin input accepted                                             |
| `AB100`–`AB160` | bundle parser and manifest     | source validation: names, versions, fields, components, policies, references, cycles |
| `AB170`         | renderer                       | duplicate output path                                                                |
| `AB180`–`AB187` | manifest and overlays          | native overlay declaration and loading                                               |
| `AB200`–`AB203` | `agent init`, `agent add`      | scaffolding                                                                          |
| `AB220`–`AB224` | `agent upgrade`                | schema migration                                                                     |
| `AB230`–`AB239` | `agent import`                 | detection, normalization, provenance                                                 |
| `AB302`–`AB370` | renderer                       | per-feature mapping losses; see below                                                |
| `AB400`–`AB414` | `agent doctor`                 | host status, undeclared paths, output drift                                          |
| `AB420`–`AB439` | `agent verify`                 | pinned versions, committed-tree drift, orphaned generated files                      |
| `AB500`–`AB509` | `agent package`                | catalog completeness, assets, collisions, pinning, archives                          |
| `AB600`–`AB607` | `agent audit`                  | what hook and MCP commands actually run                                              |
| `AB610`–`AB614` | `agent audit`                  | credentials and environment handed to MCP servers                                    |
| `AB620`–`AB624` | `agent audit`                  | how broad the permission grants are                                                  |
| `AB630`–`AB634` | `agent audit`                  | executables, binaries, symlinks, and total size                                      |
| `AB640`–`AB642` | `agent audit`                  | manifest claims with nothing behind them                                             |
| `AB650`–`AB654` | `agent audit`                  | baseline drift against a previous `sbom.json`                                        |
| `AB700`–`AB720` | `agent test`                   | test-file validity, assertion failures, skips                                        |
| `AB800`–`AB809` | `agent install` / `uninstall`  | locations, manifests, registration, co-resident installs                             |
| `AB900`–`AB907` | `agent marketplace`            | collection spec: schema, required and malformed fields, bundle paths, selection      |
| `AD001`–`AD005` | `jira adf` input reader        | invocation, I/O, and input bounds                                                    |
| `AD100`–`AD112` | `jira adf validate`            | ADF source validation: unknown types, illegal nesting, attributes                    |
| `AD200`–`AD211` | `jira adf to-markdown`         | ADF to Markdown mapping losses                                                       |
| `AD300`–`AD311` | `jira adf from-markdown`       | Markdown to ADF mapping and degradation                                              |
| `AD400`–        | —                              | reserved for a future round-trip fidelity mode                                       |
| `AP000`–`AP019` | `pdf` reader and loader        | invocation, I/O, input bounds, encryption, resource budgets                          |
| `AP020`–`AP049` | `pdf` page walker              | the page tree and per-page decoding                                                  |
| `AP050`–`AP079` | `pdf text`, `pdf inspect`      | the text layer: absent, sparse, undecodable                                          |
| `AP080`–`AP099` | `pdf outline`                  | unresolvable destinations, depth                                                     |
| `AP100`–`AP130` | `pdf validate`                 | structural integrity: xref recovery, fonts, filters, metadata, tagging claims        |
| `AP200`–`AP240` | `pdf to-markdown`              | reading order, structure inference, and mapping losses                               |
| `AP300`–`AP330` | `pdf attachments`, `pdf forms` | embedded files, name sanitization, extraction collisions, form fields                |
| `AP600`–        | —                              | reserved for a future `pdf audit`                                                    |

The `AD` range is chosen by where the condition is detected, not by which command the user typed:
`AD100` and `AD101` are emitted by both `jira adf validate` and `jira adf to-markdown`, on the
same one-condition-one-identifier rule the `AB` family follows. `AP` follows it too — `AP020` is
emitted by `pdf inspect` and `pdf validate` alike, and `AP050` by three commands.

### The renderer range in detail

`AB3xx` is organized by feature, which is why a target profile's `features[].diagnostics` reads
as a short list:

| Code    | Feature      | Condition                                                           |
| ------- | ------------ | ------------------------------------------------------------------- |
| `AB170` | —            | duplicate output path                                               |
| `AB302` | placeholders | no portable `$ARGUMENTS` substitution; explanatory text emitted     |
| `AB310` | skills       | this target's skill invocation policy is advisory                   |
| `AB320` | hooks        | a hook event is not portable to this target                         |
| `AB321` | hooks        | a Windows-specific hook command requires a target override          |
| `AB322` | hooks        | a hook protocol is not portable                                     |
| `AB330` | agents       | the model is not a stable semantic class; the target inherits       |
| `AB331` | agents       | tool capabilities cannot be restricted exactly                      |
| `AB332` | agents       | capability-based tool restrictions require a target override        |
| `AB340` | agents       | this target emits no custom agents for the profile being rendered   |
| `AB350` | rules        | this target's instruction rules are project-only                    |
| `AB351` | rules        | a rule activation is not exact on this target                       |
| `AB360` | policies     | command policies are emitted only in project profiles               |
| `AB361` | policies     | this target has no native command-policy format                     |
| `AB370` | mcp          | Codex project MCP requires TOML and cannot be translated losslessly |

The overlay codes are declared by every target's `native` feature:

| Code    | Condition                                                                                            |
| ------- | ---------------------------------------------------------------------------------------------------- |
| `AB181` | an overlay collides with, or replaces, a portable artifact                                           |
| `AB182` | an invalid overlay manifest fragment, no manifest to merge into, or an override of a generated field |
| `AB183` | an overlay root or path escapes the bundle or the target root                                        |
| `AB186` | an overlay entry is not an output-profile directory                                                  |
| `AB187` | the overlay declares a profile this target does not support                                          |

## Streaming formats

### `--format jsonl`

One JSON object per line. Findings and results stream first, followed by **exactly one**
summary record:

```jsonc
{ "type": "finding", "file": "docs/a.md", "line": 3, "checker": "ref/link", "message": "…" }
{ "type": "result",  "url": "https://…", "status": 404, "ok": false }
{ "type": "summary", "files": 42, "findings": 2, "total": 10, "broken": 1 }
```

`type` is `finding`, `result`, or `summary`. The published schema is `diagnostic-record`.

### `--format sarif`

SARIF 2.1.0, referencing the
[external schema](https://json.schemastore.org/sarif-2.1.0.json) rather than redefining it.

```jsonc
{
  "version": "2.1.0",
  "$schema": "https://json.schemastore.org/sarif-2.1.0.json",
  "runs": [
    {
      "tool": {
        "driver": {
          "name": "cairn",
          "informationUri": "https://github.com/cairn-tool/cairn",
          "rules": [{ "id": "…", "name": "…" }],
        },
      },
      "results": [
        {
          "ruleId": "…",
          "level": "error",
          "message": { "text": "…" },
          "locations": [
            {
              "physicalLocation": {
                "artifactLocation": { "uri": "docs/a.md" },
                "region": { "startLine": 3 },
              },
            },
          ],
        },
      ],
    },
  ],
}
```

**The key order is load-bearing.** `JSON.stringify` follows insertion order, so reordering a key
silently changes the bytes every existing SARIF consumer receives. `tests/unit/automation.test.ts`
asserts byte equality against a fixed input.

### Two SARIF producers, one envelope

The five `md` diagnostic commands and `agent audit` share `sarifDocument`, but map into it
differently:

|              | `md` commands                                     | `agent audit`                                                               |
| ------------ | ------------------------------------------------- | --------------------------------------------------------------------------- |
| `level`      | always `"error"` — an `Issue` carries no severity | three levels, from the diagnostic's severity                                |
| `region`     | `startLine` from the finding                      | **omitted** — a diagnostic identifies a file and a condition, never a line  |
| `properties` | none                                              | `quality`, and `target`, `profile`, `component`, `remediation` when present |
| stream       | stderr                                            | **stdout**                                                                  |

That is why the agent mapper lives separately in `src/agent/sarif.ts` rather than reusing the
`md` writer.

A diagnostic with no `path` at all is about the bundle as a whole and is located at
`agent-bundle.yaml`.

## Exit codes

| Code | Meaning                                 |
| ---- | --------------------------------------- |
| `0`  | success; no actionable findings         |
| `1`  | invocation, I/O, or configuration error |
| `2`  | actionable findings                     |

Per-command meanings are in `cairn describe` output under `exitCodes`.

`agent` commands do **not** all share one rule. The default `hasFindings` fails on any
`approximate` diagnostic, which is right for `convert` and `validate` and wrong for `doctor`,
`import`, `upgrade`, `package`, `audit`, and `test`, where approximation is the expected
outcome rather than a defect. Those decide their own exit. A new command reporting
approximations should do the same.

`jira adf` is one of those, and deliberately not the `agent convert` rule: an error always
blocks, and an `approximate` or `unsupported` finding blocks only under `--strict`. Almost every
real Jira description carries an approximation, so failing on one by default would make a working
conversion indistinguishable from a broken one.

| Command                                          | Exits 2 when                                                    |
| ------------------------------------------------ | --------------------------------------------------------------- |
| `jira adf to-markdown`, `jira adf from-markdown` | Any error; any `approximate` or `unsupported` under `--strict`. |
| `jira adf validate`                              | Any error; `AD100` or `AD101` under `--strict`.                 |
| `jira adf inspect`                               | Never. It reports no findings of its own.                       |

**`ok: true` therefore does not mean the conversion was lossless.** Read `diagnostics` for that.

## Related

- [Machine-readable result contract](../contract.md) — streams, schemas, and the envelope
- [Audit baselines](audit-baseline.md)
- [Target profile format](target-profile.md#features) — where per-target codes are declared
