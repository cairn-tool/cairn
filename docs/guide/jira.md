# Jira and Confluence rich text

Why the `jira` toolset exists, and what makes a lossy conversion trustworthy anyway.

Jira Cloud's REST API v3 and Confluence Cloud never accept or return Markdown. Every rich-text
field — an issue description, a comment, a page body — is **Atlassian Document Format**: a JSON
tree of typed nodes and marks. Reading one as prose means reading JSON, and writing one by hand
means hand-building a tree that the API will reject for reasons it does not explain well.

`cairn jira adf` converts both ways, deterministically and locally: no credentials, no network,
no model call.

```bash
# ADF in hand, Markdown wanted
curl -s "$JIRA/rest/api/3/issue/PROJ-1" \
  | jq .fields.description \
  | cairn jira adf to-markdown -

# Markdown in hand, an API body wanted
cairn jira adf from-markdown notes.md --output body.json

# Neither: just tell me what is in here first
cairn jira adf inspect description.json
```

## The unit is a document, not a response

Every subcommand takes a **bare ADF document** — a JSON object with `"type": "doc"`. It knows
nothing about the REST response shape, and there is deliberately no `--pointer`, `--field`, or
`--issue` option.

That is not an omission. Handing `jira adf to-markdown` a whole issue response is the likeliest
first mistake, so when a document is nested somewhere inside the input, `AD002` names the field
and prints the `jq` that extracts it. A message that teaches the pipeline is worth more than an
option that hides it, and it keeps the tool out of the business of tracking Atlassian's response
shapes across API versions.

## Conversion is lossy, and says so

ADF has constructs Markdown has no form for — panels, expands, decision lists, column layouts,
status lozenges, mentions. Markdown permits nestings ADF forbids, such as a heading inside a list
item. So neither direction is total, and every loss reports an `AD###` code naming the node, its
location in the tree, and what happened to it.

The rule the degradations follow is **flatten in place, never lift**. Promoting a heading out of
a list item would move it past the text that followed it, producing output that is legal,
plausible, and says something the input did not.

**Exit 0 does not mean lossless.** Approximation is the expected outcome on almost every real
issue description, so an approximate finding blocks only under `--strict`; an error always
blocks. `ok: true` in the JSON payload means "converted", not "converted without loss" — read
`diagnostics` for that. This is deliberately not the `agent convert` rule, which fails on any
approximation: applied here it would make a working conversion indistinguishable from a broken
one.

## The document owns stdout

Findings go to stderr, unlike every `agent` subcommand, which puts them on stdout. That is what
makes this safe:

```bash
cairn jira adf to-markdown description.json > out.md
```

The redirect captures the document and nothing else; the findings still reach the terminal. Under
`--format json` both move to stdout in one payload instead — which also means `-fj` on
`jira adf from-markdown` is not "the same output in JSON": the default already emits pure ADF,
and `-fj` wraps it.

## Why the content model can be trusted

`src/jira/adf/profile.ts` holds the ADF content model and the degradation table as **data**, and
both converters read it rather than branching on node type. On its own that is just a table
someone typed.

What makes it trustworthy is `tests/unit/jira-adf-profile.test.ts`. It compiles Atlassian's own
published JSON Schema — `@atlaskit/adf-schema`, a devDependency read from nowhere else and
shipped nowhere — and checks the profile against it in **both** directions, so the model can
neither permit a nesting ADF forbids nor needlessly degrade one it allows. It also fails the
build on any parent/child pair the Markdown walk can form that has neither a legal mapping nor a
degradation rule.

Nothing is vendored and nothing is generated. Deriving the model from that schema at runtime was
considered and rejected: it trades a small authored table for a parser against someone else's
schema structure, which a restructure breaks and the agreement test would have survived.

A node type the model does not know reports `AD100` rather than being judged — the same line
`agent test --native` draws. `jira adf validate` reports against this profile and never claims to
be Atlassian's validator.

## Related

- [Complete command listing](../commands.md#jira-commands) — the four subcommands.
- [Shared `jira adf` behavior](../commands/jira/adf/common.md) — options, streams, and exit codes.
- [Diagnostics](../formats/diagnostics.md#conversiondiagnostic) — the finding shape.
- [Diagnostic codes](../formats/diagnostic-codes.md#adf-invocation-and-input) — every `AD###`.
