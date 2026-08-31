# `jira adf` common behavior

Shared by every [`jira adf`](../../../commands.md#jira-commands) subcommand. The per-command pages cover
only what differs.

## The unit of conversion is a document, not a response

Every subcommand takes a **bare Atlassian Document Format document** — a JSON object with
`"type": "doc"`. It has no knowledge of the Jira or Confluence REST response shape, and there is
no `--pointer`, `--field`, or `--issue` option. Narrowing a response is the caller's step:

```bash
curl -s "$JIRA/rest/api/3/issue/PROJ-1" | jq .fields.description | cairn jira adf to-markdown -
```

Passing a whole issue response reports [`AD002`](../../../formats/diagnostic-codes.md#adf-invocation-and-input),
and when a document is nested somewhere inside the input the remediation names the field and
prints the `jq` command that extracts it. That message is why the option does not exist.

## Input

| Source | Behavior                                               |
| ------ | ------------------------------------------------------ |
| A path | Read after resolving symlinks; must be a regular file. |
| `-`    | Read from stdin.                                       |

Reads are bounded the way [`md check-snippets`](../../md/check-snippets.md) bounds a snippet source,
because ADF arrives off a network: symlinks resolved, non-regular files refused so a FIFO cannot
wedge the process, two megabytes maximum, NUL rejected, and a 200-level nesting cap. The nesting
cap is a correctness guard rather than hygiene — both converters walk the tree recursively, and
without it a deep document exits with a stack overflow and no diagnostic.

No `.cairn.yml` configuration applies. These commands do not load project configuration at all,
so nothing in a workspace can change how a conversion behaves.

## Streams

**The converted document owns stdout. Diagnostics go to stderr.**

This differs from every [`agent`](../../../commands.md#agent-commands) subcommand, which puts findings
on stdout, and it is the reason redirection works:

```bash
cairn jira adf to-markdown issue.json > description.md   # findings stay on the terminal
```

Under `--format json` the payload carries the document and the findings together, and goes to
stdout instead. So `-fj` is not "the same output, in JSON" — see
[`jira adf from-markdown`](from-markdown.md), where the default output is already JSON.

## Options

| Option           | Default | Description                                                   |
| ---------------- | ------- | ------------------------------------------------------------- |
| `--format <fmt>` | `llm`   | `llm`, `human`, or `json`. Not configurable per project.      |
| `--envelope`     | `false` | Wrap `--format json` output in the versioned result envelope. |
| `-h`, `--help`   | —       | Show help.                                                    |

`-fh` and `-fj` expand to `--format=human` and `--format=json` before parsing.

## Exit codes and what `ok` means

| Condition                                        | Code |
| ------------------------------------------------ | ---- |
| Converted or checked                             | `0`  |
| Invocation or I/O error, or the input is not ADF | `1`  |
| A blocking finding                               | `2`  |

An `error` always blocks. An `approximate` or `unsupported` finding blocks **only under
`--strict`**, which is deliberately not the [`agent convert`](../../agent/convert.md) rule: almost every
real Jira description carries an approximation, so failing on one by default would make a working
conversion indistinguishable from a broken one. The same split gives
[`agent audit`](../../agent/audit.md) and [`agent test`](../../agent/test.md) their own rules.

**So `ok: true` does not mean the conversion was lossless.** Read `diagnostics` for that, or run
[`jira adf inspect`](inspect.md) first to see the cost before paying it.

## Stability

All four commands are `stability: "experimental"`. The payload shape may change without a major
schema version — see [the contract](../../../contract.md#experimental-commands). Read shapes through
`cairn describe adf -fj` and `cairn schema adf-result` rather than hardcoding them.

## Related surfaces

- [`jira adf to-markdown`](to-markdown.md) and [`jira adf from-markdown`](from-markdown.md) convert.
- [`jira adf validate`](validate.md) checks structure without converting.
- [`jira adf inspect`](inspect.md) reports what a document contains and what it will cost.
- [Diagnostics](../../../formats/diagnostics.md#conversiondiagnostic) catalogs every `AD###` code.
