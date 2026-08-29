# `md graph`

## Synopsis

```text
cairn md graph [directory] [options]
```

Builds the selected Markdown document graph and reports inbound/outbound counts, broken
Markdown targets, dead ends, weak components, strongly connected cycles, and reachability.
Without an applicable entry point, reachability is reported as unevaluated.

## Arguments

| Argument    | Required | Description                                                   |
| ----------- | -------- | ------------------------------------------------------------- |
| `directory` | No       | Directory to scan. Defaults to the configured workspace root. |

## Options

| Option                | Default             | Description                                                        |
| --------------------- | ------------------- | ------------------------------------------------------------------ |
| `--format <fmt>`      | Project default     | Report rendering: `llm`, `human`, or `json`.                       |
| `--paths <style>`     | Project default     | `absolute` or `relative`.                                          |
| `--stdin-name <path>` | None                | Shared option; graph scans use files.                              |
| `--output <mode>`     | `report`            | `report`, raw deterministic `mermaid`, or raw deterministic `dot`. |
| `--entry <file>`      | `files.entryPoints` | Repeatable reachability root.                                      |
| `--focus <file>`      | None                | Repeatable neighborhood root.                                      |
| `--depth <n>`         | `1`                 | Undirected hops around `--focus`, `0` to `6`.                      |
| `--include <glob>`    | `files.include`     | Repeatable include glob.                                           |
| `--exclude <glob>`    | `files.exclude`     | Repeatable exclude glob.                                           |
| `-h`, `--help`        | —                   | Show help.                                                         |

## Focusing on a neighborhood

`--focus` narrows the report **and** the `mermaid`/`dot` diagrams to the documents within
`--depth` undirected hops of the named files, which is what makes a large workspace diagram
readable. The walk is undirected on purpose: "what touches this document" is the question a
neighborhood answers, and a directed walk would hide every backlink.

The graph is analyzed **in full first** and the neighborhood is projected from it. That
distinction is load-bearing:

- A link to an in-workspace document outside the radius stays a resolved edge. Narrowing the
  file selection first would report it as a broken target that does not exist.
- `inbound`, `outbound`, and `deadEnd` keep their whole-workspace values. A node drawn with two
  neighbors can legitimately report `inbound: 9`; it describes the document, not the picture.
- A weak component or cycle is reported **whole** when any member is in focus, rather than
  intersected with it. A truncated cycle group would read as a self-link that is not there.

`broken` is filtered by source document, and `unreachable` and `entries` by membership. The
exit code follows the narrowing, so a focused run reports only findings inside the
neighborhood. A `--focus` path outside the selected set is an error rather than an empty
result.

```jsonc
"focus": { "files": ["docs/commands.md"], "depth": 1, "nodes": 41, "omitted": 7 }
```

The block is present only when `--focus` was given, so unfocused output is unchanged.

## Exit codes

Broken targets and documents unreachable from applicable entry points exit `2`. Informational
metrics alone exit `0`. An unknown `--output` mode, an entry point or focus document that does
not exist, or a `--depth` outside `0` to `6` exits `1`.
