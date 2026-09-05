---
name: adf-convert
description: Convert Jira and Confluence rich text between Atlassian Document Format and Markdown with the cairn jira toolset, in both directions, reporting exactly what each conversion approximated or lost. Use when asked to turn a Jira issue description or comment into Markdown, to turn a Markdown document into ADF for a Jira or Confluence API call, or to check what an ADF document contains before converting it.
---

# Converting Jira and Confluence rich text

Jira Cloud's REST API v3 and Confluence Cloud never accept or return Markdown — every rich-text
field is Atlassian Document Format, a JSON tree of typed nodes and marks. `cairn jira adf`
converts both ways, deterministically and locally: no credentials, no network, no model. Use it
instead of hand-writing ADF or reading a JSON tree as prose.

Confirm the toolset exists before relying on it: `cairn describe jira adf -fj` lists the four
subcommands. If the group is absent, the installed cairn predates this feature — say so and stop
rather than guessing at flags. All four are `stability: experimental`, so read payload shapes
through `cairn describe` and `cairn schema adf-result` rather than hardcoding them.

## Commands

| Command                           | When                                                            |
| --------------------------------- | --------------------------------------------------------------- |
| `jira adf to-markdown <source>`   | An ADF document is in hand and Markdown is wanted.              |
| `jira adf from-markdown <source>` | A Markdown document is in hand and an API body is wanted.       |
| `jira adf validate <source>`      | Check that ADF is structurally legal before sending it.         |
| `jira adf inspect <source>`       | Ask what a document contains, and what converting it will cost. |

`-` reads stdin for all four. Both converters take `--output <file>` (default stdout) and
`--strict`. There is no MCP tool for any of these — stay on the CLI.

## It converts a document, not a REST response

**This is the mistake to avoid.** Every subcommand takes a bare ADF document: an object with
`"type": "doc"`. It knows nothing about Jira's response shape, and there is no `--pointer`,
`--field`, or `--issue` option. Extract the field first:

```bash
curl -s "$JIRA/rest/api/3/issue/PROJ-1" | jq .fields.description | cairn jira adf to-markdown -
```

Passing a whole issue response exits `1` with `AD002`, and the message names the field to extract
and prints the `jq` command for it. If you see `AD002`, read the remediation and re-run — do not
start reshaping the JSON by hand.

## Streams

**The converted document is on stdout. Diagnostics are on stderr.** This is the opposite of every
`cairn agent` command, and it is what makes redirection safe:

```bash
cairn jira adf to-markdown issue.json > description.md   # findings do not land in the file
```

So do not parse stdout for findings, and do not read a clean stdout as a clean conversion. Under
`--format json` the payload carries both and goes to stdout instead.

## `-fj` is not "the same output, in JSON"

For `from-markdown` the default output is **already** ADF JSON. `--format json` wraps that
document alongside the findings:

```bash
cairn jira adf from-markdown notes.md                                     # the ADF document, alone
cairn jira adf from-markdown notes.md | jq '{fields: {description: .}}'   # a request body
cairn jira adf from-markdown notes.md -fj | jq -r '.diagnostics[].code'   # machine-readable findings
```

Use the default when the document is the product. Use `-fj` when the findings are.

## Exit codes, and why `0` does not mean lossless

| Code | Meaning                                                           |
| ---- | ----------------------------------------------------------------- |
| `0`  | Converted or checked. **Approximations do not fail the command.** |
| `1`  | Invocation or I/O error, or the input is not an ADF document.     |
| `2`  | An error — or, under `--strict`, any approximation.               |

Conversion is lossy in both directions, and almost every real Jira description carries an
approximation, so failing on one by default would make a working conversion indistinguishable
from a broken one. **Read `diagnostics` to know what happened; never report a conversion as
lossless because it exited `0`.** Add `--strict` when the task genuinely requires fidelity — a CI
gate, or a document being converted for archival.

Findings carry an `AD###` code, a `quality` of `exact`, `approximate`, or `unsupported`, and a
`location` naming the ancestor path. [`reference/fidelity.md`](reference/fidelity.md) maps every
construct in both directions; read it when a user asks what will survive, or when explaining a
specific finding.

## Practice

1. **Inspect before converting anything you did not author.** `cairn jira adf inspect issue.json`
   lists each node and mark type with its fidelity, so the cost is known before it is paid. Cheap,
   and it turns "convert this" into an informed answer.
2. **Extract the field, then convert.** `jq .fields.description` for a description, `jq .body` for
   a comment. One pipeline, not a hand-edited file.
3. **Report the losses, do not bury them.** After converting, summarize the non-`exact` findings in
   plain language. "Two panels became block quotes and one attachment could not be linked" is the
   useful answer; "converted successfully" is not.
4. **Never invent an attachment URL.** An attachment with no URL becomes
   `[attachment <id>](media:<id>)`. That `media:` target is deliberately not fetchable — cairn has
   no site URL and neither do you. Hand the id back to the user rather than constructing a link.
5. **Check a document you assembled before sending it.** `cairn jira adf validate body.json`
   catches what a Jira API would reject, including the easy one: an empty table cell is ordinary
   Markdown and `"content": []` is invalid ADF.
6. **Expect the first Markdown pass to move bytes.** `from-markdown` then `to-markdown` normalizes
   emphasis markers, heading style, and list markers. It is stable from the second pass on, so do
   not read the first diff as data loss.
7. **Do not edit ADF by hand to fix a conversion.** Fix the Markdown and convert again, or report
   the limitation. Hand-edited ADF is how invalid documents reach the API.
