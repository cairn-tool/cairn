# Query, context, and graph in full

See [`cli-basics.md`](../../../assets/cli-basics.md) for formats, exit codes, and config
discovery.

## `md query <kind> [directory]`

Two modes share the `kind` argument. Without `--where`, `--select`, or `--group-by`, the shortcut
kinds emit their own fixed shapes. With any of them, `kind` names an **entity** to filter.

Query matches are informational and exit `0`. An unknown field, predicate, or operator exits `1`
rather than matching nothing — a typo is an error, never a quiet empty result.

### Shortcut kinds

| Kind               | Answers                             | Options                                                |
| ------------------ | ----------------------------------- | ------------------------------------------------------ |
| `links-to`         | Which documents link to a target    | `--target <path>[#fragment]`                           |
| `duplicates`       | Colliding values across documents   | `--field title\|slug\|heading-slug\|frontmatter:<key>` |
| `unused-assets`    | Assets nothing references           | `--asset-extension <ext>` (repeatable)                 |
| `code-blocks`      | Fenced blocks across the workspace  | `--lang <language>`, `--content`                       |
| `tasks`            | Checkbox items across the workspace | `--status all\|done\|pending`, `--summary`             |
| `missing-h1`       | Documents with no top-level heading | —                                                      |
| `frontmatter-keys` | Which frontmatter keys are in use   | —                                                      |

### Predicate mode

Entities: `documents`, `headings`, `links`, `tasks`, `code-blocks`, `frontmatter`.

Predicates are `<field><op><value>`, where `<op>` is one of `=`, `!=`, `~`, `>`, `>=`, `<`, `<=`.
Also available: `has:<field>` and `links-to:<path>`. A leading `!` negates. Repeating `--where`
ANDs them. `frontmatter.<key>` is a field on every entity.

```bash
md query documents --where has:h1 --select file,title
md query links --where links-to:docs/api.md --select file,line
md query tasks --where status=pending --group-by frontmatter.owner
md query headings --where depth=1 --select file,text
md query documents --where '!has:h1'
md query code-blocks --where lang=bash --select file,line
```

| Option               | Meaning                                     |
| -------------------- | ------------------------------------------- |
| `--where <pred>`     | Filter predicate, repeatable and AND-ed     |
| `--select <fields>`  | Comma-separated fields to emit (repeatable) |
| `--group-by <field>` | Group rows by one field                     |

## `md context [seeds...]`

Assembles a reproducible context pack by walking the reference graph from the seeds. Units are
ordered by graph distance, then discovery order, then document order — so a truncated pack still
leads with the most relevant material.

| Option                | Meaning                                               |
| --------------------- | ----------------------------------------------------- |
| `--depth <n>`         | Graph hops from the seeds (0-6)                       |
| `--backlinks`         | Follow references backwards as well as forwards       |
| `--section <heading>` | Restrict seeds to this heading (repeatable)           |
| `--children`          | Expand `--section` through its subsections            |
| `--target <path>`     | Seed with documents referencing this path[#fragment]  |
| `--budget <bytes>`    | Maximum UTF-8 bytes of unit content; `0` is unlimited |
| `--frontmatter`       | Emit each document's frontmatter as its own unit      |

Set `--budget` on any tree big enough that depth 2 or 3 might pull in most of it.

## `md graph [directory]`

| Option            | Meaning                                              |
| ----------------- | ---------------------------------------------------- |
| `--output <mode>` | `report` (default), `mermaid`, or `dot`              |
| `--entry <file>`  | Entry point for reachability (repeatable)            |
| `--focus <file>`  | Restrict to one document's neighborhood (repeatable) |
| `--depth <n>`     | Undirected hops around `--focus`                     |

`--entry` is how you distinguish "unreachable" from "orphaned": a document reachable only from a
page nothing links to is still unreachable.

## `md index <action> [directory]`

Actions are `status`, `build`, and `clear`. The index backs `query`, `context`, and `graph` and
maintains itself; reach for `build` when results look stale and `clear` when they look wrong.
