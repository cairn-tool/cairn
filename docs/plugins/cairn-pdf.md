# `cairn-pdf`

Source: `plugins/cairn-pdf/`. Bundle `schemaVersion: "2"`, version `1.0.0`.

Wraps the `pdf` toolset: extracting a PDF's text layer, reading its outline, checking its structural integrity, and converting its content to Markdown, reporting per construct what was inferred and what was lost.

See [the `pdf` command listing](../commands.md#pdf-commands) for the commands this skill invokes,
and [Cairn's own plugins](../plugins.md) for installing, building, and versioning all seven.

## At a glance

| Component           | Count             |
| ------------------- | ----------------- |
| Skills              | 1 (model-invoked) |
| Subagents           | 0                 |
| Hooks               | 0                 |
| MCP servers         | 0                 |
| Assets              | 0                 |
| Contract test cases | 5                 |

## Skills

| Skill                   | Invocation    | Reference     |
| ----------------------- | ------------- | ------------- |
| [`pdf-read`](#pdf-read) | model-invoked | `fidelity.md` |

### `pdf-read`

Read PDF documents with the cairn pdf toolset — extract the text layer, read the outline, check structural integrity, and convert content to Markdown, reporting what each conversion inferred or lost.

Model-invoked rather than a slash command: meeting a PDF is something an assistant should recognize
on its own, not something a user has to know to ask for by name.

The body leads with `pdf inspect` because two fields decide what every other command can answer —
whether the document has a text layer at all, and whether its structure is declared or inferred. The
three failure modes it exists to prevent are an assistant reporting an inferred heading structure as
the document's own, hand-rebuilding a table the tool deliberately refused to reconstruct, and
casting about for another command when the real answer is "this page is an image and there is no
OCR here".

Reference sidecar: `reference/fidelity.md`, loaded only when the body points at it. It maps what
survives each of the two conversion paths with the code that reports it, which is what turns "some
things were approximated" into a specific answer.

## Subagents

None. A subagent earns its place when a workflow would otherwise flood the conversation with
intermediate output. Reading a PDF answers in one or two steps, and the interesting part is the
diagnostic list, which is already short.

## Hooks

None. Nothing here should fire implicitly. `pdf text` and `pdf to-markdown` write files under
`--output`, and a conversion the user did not ask for is a file they did not expect.

## MCP servers

None registered **here**, but six read-only PDF tools now ship on the `cairn` server — `inspect_pdf`,
`read_pdf_text`, `convert_pdf_to_markdown`, `get_pdf_outline`, `list_pdf_attachments`, and
`list_pdf_form_fields`. That server is registered by [`cairn-markdown`](cairn-markdown.md) and
nowhere else, because `cairn serve mcp` is one server carrying every toolset's tools: registering it
again here would hand a host that installs both plugins the same seventeen tools twice.

This resolves what was previously an open question. The tension was real — every path on that
surface is confined to `--root`, while a PDF handed to the CLI has nothing to do with a workspace —
and it is settled by accepting the confinement rather than adding a second boundary. A PDF must live
under the served root to be readable there; anything outside it, and anything that writes, stays on
the CLI. Extraction is deliberately unreachable over MCP: `list_pdf_attachments` inventories and
there is no tool that writes a file.

## Assets

None. The one long reference belongs to the single skill, so it lives in that skill's `reference/`
rather than in a bundle-wide asset shared by nobody.

## Contract tests

`plugins/cairn-pdf/tests/render.test.yaml`, run by [`agent test`](../commands/agent/test.md).

| Case                                    |
| --------------------------------------- |
| `renders-a-complete-claude-code-plugin` |
| `manifest-omits-the-implied-fields`     |
| `the-skill-stays-model-invocable`       |
| `the-skill-pins-the-load-bearing-facts` |
| `the-fidelity-reference-ships`          |

`the-skill-pins-the-load-bearing-facts` asserts the five things a caller gets wrong without reading
the skill: that the command path is two tokens, that the streams are split, that exit `0` is not
lossless, that there is no OCR, and that nothing here writes a PDF. Each is a sentence an edit could
plausibly drop, and each would produce confidently wrong behavior if it did.

These are model-free: every expectation is evaluated against the same in-memory render
`agent convert` would write.

## Rendering

The collection publishes this plugin for Claude Code only, in the `plugin` profile. The bundle
itself stays portable — `cairn agent convert plugins/cairn-pdf --target all` renders it for every
host — but Claude Code is the only marketplace published.

## Related

- [Cairn's own plugins](../plugins.md) — installing, building, and versioning all seven.
- [Reading PDF documents](../guide/pdf.md) — why the toolset exists.
- [Agent bundle format](../formats/agent-bundle.md) — the source format this is written in.
- [Bundle contract tests](../formats/agent-tests.md) — the assertion format above.
