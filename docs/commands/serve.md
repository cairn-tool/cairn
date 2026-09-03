# `serve`

## Synopsis

```text
cairn serve <protocol> [options]
```

Serves the Markdown workspace engine, and a read-only view of PDF documents, over a machine
protocol. The only protocol today is `mcp`, which speaks the
[Model Context Protocol](https://modelcontextprotocol.io) over stdio so a compatible host can call
them directly instead of spawning the CLI and parsing its output.

Every tool is read-only, and every path argument is confined to `--root`.

## Arguments

| Argument     | Required | Description      |
| ------------ | -------- | ---------------- |
| `<protocol>` | Yes      | Protocol: `mcp`. |

## Options

| Option                | Default                | Description                                                          |
| --------------------- | ---------------------- | -------------------------------------------------------------------- |
| `--root <dir>`        | `.`                    | Directory to serve. Every path argument is confined to it.           |
| `--config <file>`     | discovered             | Path to a configuration file.                                        |
| `--no-config`         | —                      | Ignore any configuration file.                                       |
| `--max-documents <n>` | `2048`                 | Parsed documents held in memory before least-recently-used eviction. |
| `--concurrency <n>`   | CPU count, capped at 8 | Parallel lints during `audit_markdown`.                              |
| `-h`, `--help`        | —                      | Show help.                                                           |

There is no `--format`. stdout carries JSON-RPC frames rather than a payload, so there is
nothing for a format to select; diagnostics go to stderr, which MCP treats as the server log.

## Registering with a host

```bash
claude mcp add markdown -- cairn serve mcp --root docs
```

The server is spawned by the host, reads requests on stdin, and writes responses on stdout.
It exits `0` when the client disconnects.

## Tools

| Tool               | Equivalent command | Purpose                                                        |
| ------------------ | ------------------ | -------------------------------------------------------------- |
| `list_documents`   | —                  | The Markdown documents under a directory.                      |
| `get_section`      | `md section`       | One section by heading text or slug, with its line range.      |
| `query_workspace`  | `md query`         | Composable `where`/`select`/`group-by` query over an entity.   |
| `build_context`    | `md context`       | A context pack traversed from seed documents, with provenance. |
| `inspect_graph`    | `md graph`         | Edges, broken targets, reachability, components, and cycles.   |
| `audit_markdown`   | `md lint-dir`      | Style, Mermaid, KaTeX, and local-reference findings.           |
| `get_outline`      | `md outline`       | The heading tree.                                              |
| `get_frontmatter`  | `md frontmatter`   | Frontmatter, whole or by dotted key path.                      |
| `list_tasks`       | `md tasks`         | GFM task-list items and their completion state.                |
| `list_code_blocks` | `md code-blocks`   | Fenced code blocks, optionally with contents.                  |
| `find_references`  | `md refs-to`       | Every local reference resolving to a file — its backlinks.     |

PDF tools, which read a document rather than the workspace:

| Tool                      | Equivalent command | Purpose                                                      |
| ------------------------- | ------------------ | ------------------------------------------------------------ |
| `inspect_pdf`             | `pdf inspect`      | Page count, metadata, tagging, per-page text-layer forecast. |
| `read_pdf_text`           | `pdf text`         | The text layer a document already carries, page by page.     |
| `convert_pdf_to_markdown` | `pdf to-markdown`  | Content as Markdown, reporting what was inferred.            |
| `get_pdf_outline`         | `pdf outline`      | The declared bookmarks as a heading tree.                    |
| `list_pdf_attachments`    | `pdf attachments`  | Embedded files, with size and SHA-256. Inventory only.       |
| `list_pdf_form_fields`    | `pdf forms`        | AcroForm field names, types, and current values.             |

Each tool's arguments are described by its own JSON Schema, retrieved through the protocol's
`tools/list` rather than through [`schema`](schema.md). Results are JSON text matching the
equivalent command's `--format json` payload, with paths rendered relative to `--root`.

Configuration is discovered from `--root`, so a **Markdown** tool applies the same checks,
includes, and excludes as the equivalent `md` command run in that workspace. Where a command has a
long-standing quirk, the tool reproduces it rather than quietly disagreeing — `get_outline`
reports a document's frontmatter as a setext heading exactly as `md outline` does.

The PDF tools consult no configuration at all, matching the `pdf` toolset on the CLI: a checked-in
`.cairn.yml` has no say over how a document named in a tool call is parsed. Their input bounds — 64
MiB, a 30-second parse budget, 5000 pages — are the CLI defaults, applied as fixed limits because a
host has no way to pass `--max-bytes`.

A PDF must live under `--root` to be readable. That is a real narrowing, since a PDF handed to the
CLI has nothing to do with a workspace, and it is deliberate: the alternative is a second
confinement boundary on a surface whose entire claim is that there is one.

Neither `list_pdf_attachments` nor anything else here can extract an embedded file. The inventory is
available and the write is not, which is the same line that keeps
[`scripts run`](scripts/run.md) off this surface entirely.

## Read-only by construction

There is no write path in the process. Refactor tools are absent rather than gated behind a
flag, so no configuration turns this server into one that can modify a workspace. Use
[`md rename-heading`](md/rename-heading.md), [`md rename-file`](md/rename-file.md), or
[`md fix`](md/fix.md) for that, where `--dry-run` and `--write` are explicit.

The server also leaves the on-disk workspace index alone. It keeps a bounded in-memory cache
instead, so a long-running session cannot grow without limit and cannot resurrect a snapshot
that a concurrent [`md index clear`](md/index.md) deleted.

## Path confinement

Every path argument is resolved through symlinks and then checked against `--root`:

- A traversal such as `../secrets.md`, or an absolute path outside the root, is refused.
- A symlink inside the root pointing outside it is refused, and is left out of
  `list_documents` rather than served under an in-root name.
- A path of `-` is refused. On a stdio server file descriptor 0 is the protocol channel, so
  reading it as a file would deadlock the session.

A refusal never echoes the path back, since that is precisely what was withheld. Messages
that do name a file use the root-relative form.

## Errors

The distinction is deliberate, because the two need different handling:

- **JSON-RPC errors** (`-32602`) report the client's protocol mistakes: an unknown tool, or
  arguments that fail the tool's schema.
- **Tool results with `isError`** report what the workspace said: a missing file, an unmatched
  heading, a malformed query, a refused path. These come back as readable content so the model
  can correct the call and retry.

Findings are not errors. `audit_markdown` returns its issues as an ordinary result — there is
no exit-code-2 equivalent over the protocol.

## Dependencies

This command is the only reason `@modelcontextprotocol/sdk` is a dependency. The SDK hard-depends
on an HTTP and OAuth stack (`express`, `hono`, `jose`, `pkce-challenge`, and others) that a
stdio server never loads at runtime but that every install of this package still fetches. That
is a real supply-chain cost, recorded here rather than left for you to discover — the same
scrutiny [`agent audit`](agent/audit.md) applies to bundles.

## Exit codes

| Code | Meaning                                                      |
| ---- | ------------------------------------------------------------ |
| `0`  | The client closed the connection.                            |
| `1`  | Unknown protocol, unreadable root, or invalid configuration. |
