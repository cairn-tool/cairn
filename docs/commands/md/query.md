# `md query`

## Synopsis

```text
cairn md query <kind> [directory] [options]
```

Runs a read-only query across selected Markdown documents. Matches are informational and
exit `0`.

## Modes

Two modes share the `kind` argument, and which one runs is decided by whether any composable
option was given.

| Given                                     | Mode           | `kind` names              |
| ----------------------------------------- | -------------- | ------------------------- |
| No `--where`, `--select`, or `--group-by` | **Shortcut**   | One of the shortcut kinds |
| Any of them                               | **Composable** | An entity                 |

The shortcut kinds emit their historical payloads **unchanged**. `code-blocks` therefore
returns language groups on its own and flat rows once a composable option is present; that is
recorded rather than reconciled, because changing either shape would break consumers.

`links-to`, `duplicates`, `unused-assets`, `missing-h1`, and `frontmatter-keys` **reject**
composable options rather than growing a second shape. The error names the entity form that
answers the same question, for example `md query documents --where '!has:h1'` for
`missing-h1`.

## Arguments

| Argument    | Required | Description                                                    |
| ----------- | -------- | -------------------------------------------------------------- |
| `kind`      | Yes      | A shortcut kind or an entity; see the two tables below.        |
| `directory` | No       | Directory to query. Defaults to the configured workspace root. |

## Shortcut kinds

| Kind               | Relevant options        | Result                                                                    |
| ------------------ | ----------------------- | ------------------------------------------------------------------------- |
| `links-to`         | `--target` (required)   | Links resolving to a path and optional heading fragment.                  |
| `duplicates`       | `--field`               | Duplicate `title`, `slug`, `heading-slug`, or `frontmatter:<key>` values. |
| `unused-assets`    | `--asset-extension`     | Selected assets not referenced by selected Markdown.                      |
| `code-blocks`      | `--lang`, `--content`   | Fenced code blocks, optionally filtered and expanded.                     |
| `tasks`            | `--status`, `--summary` | GFM tasks or aggregate completion totals.                                 |
| `missing-h1`       | None                    | Documents without a level-one heading.                                    |
| `frontmatter-keys` | None                    | Top-level frontmatter keys, with adoption counts and value types.         |

For duplicate titles, string frontmatter `title` takes precedence over the first level-one
heading.

### `frontmatter-keys`

Inventories which top-level frontmatter keys are actually in use, which is the measurement to
take **before** writing a formal schema. Only top-level keys are counted; nested mappings are
not walked, because a schema is written against the keys authors type.

```jsonc
{
  "kind": "frontmatter-keys",
  "count": 4,
  "results": [{ "key": "owner", "documents": 12, "coverage": 0.4286, "types": ["string"] }],
  "summary": { "documents": 40, "withFrontmatter": 28, "keys": 4 },
}
```

`coverage` is `documents` divided by `summary.withFrontmatter`, rounded to four decimals — the
share of documents that _have_ frontmatter, so adding an unrelated frontmatter-less file does
not depress every key's coverage. Documents whose frontmatter is missing, malformed, or not a
mapping contribute nothing and are excluded from `withFrontmatter`.

`types` lists the distinct value types seen across documents; more than one entry means the key
is used inconsistently, which is usually the thing worth fixing. Rows are sorted by key in byte
order.

## Entities and fields

Fields marked default are emitted when `--select` is not given.

| Entity        | Default fields                          | Also queryable                                                           |
| ------------- | --------------------------------------- | ------------------------------------------------------------------------ |
| `documents`   | `file`, `title`                         | `h1`, `headings`, `links`, `tasks`, `code`, `words`, `frontmatterStatus` |
| `headings`    | `file`, `line`, `depth`, `text`, `slug` | —                                                                        |
| `links`       | `file`, `line`, `linkText`, `target`    | `isImage`, `isExternal`, `isAnchorOnly`, `referenceType`                 |
| `tasks`       | `file`, `line`, `checked`, `text`       | `status` (`done` or `pending`)                                           |
| `code-blocks` | `file`, `line`, `endLine`, `language`   | `content`, `lines`                                                       |
| `frontmatter` | `file`, `key`, `value`, `type`          | —                                                                        |

**`frontmatter.<dotted.key>` is a field on every entity**, read from the containing document.
That is what makes `md query tasks --group-by frontmatter.owner` work without a join.

`documents` deliberately has no `line`. A per-occurrence field on a per-document entity is a
hidden join; asking for one is a usage error naming the entity that actually has it.

Headings inside a frontmatter block are excluded. The underlying parser has no frontmatter
extension, so a short block would otherwise surface a phantom `title: X` heading.

## Predicates

```text
term       := named | comparison
named      := "!"? NAME ":" ARG
comparison := FIELD OP VALUE
OP         := "!=" | ">=" | "<=" | "=" | "~" | ">" | "<"
```

A term is a named predicate only when the text before the first colon is a valid predicate
name **and** that colon comes before any operator — so `links-to:docs/api.md` is named while
`target=https://example.com` is a comparison.

| Operator          | Meaning                                  |
| ----------------- | ---------------------------------------- |
| `=`               | Exact match, **case-sensitive**.         |
| `!=`              | Not equal.                               |
| `~`               | Substring, **case-insensitive**.         |
| `>` `>=` `<` `<=` | Numeric comparison. Numeric fields only. |

| Named predicate   | Valid on             | True when                                       |
| ----------------- | -------------------- | ----------------------------------------------- |
| `has:<field>`     | Every entity         | The field is set and not empty, zero, or false. |
| `links-to:<path>` | `documents`, `links` | A reference resolves to that path.              |

A leading `!` negates a named predicate. `links-to:` accepts a `#fragment`, which narrows the
match to references carrying that anchor.

Repeating `--where` **conjoins** the terms. There is no `OR`: it would require precedence,
grouping, and quoting rules — the expression language this model deliberately avoids. Use `~`
for the common case, or merge two `-fj` runs with `jq -s 'add'`, which is well defined because
rows are deterministically ordered.

### Typing

A field with a declared type validates its operator and operand at **plan** time, so
`--where checked=maybe` and `--where text>3` fail immediately. A `frontmatter.<key>` field is
untyped YAML and can only be coerced at evaluation, so a mismatch there simply does not match
— the one place a typo cannot be caught early.

Arrays match existentially: `frontmatter.tags=api` matches when any element does, and
`frontmatter.tags!=api` when none does. A missing value never matches `=`, `~`, or an ordering,
and always matches `!=`; use `has:` when presence is what you mean.

## Output

Composable mode adds two properties, both absent in shortcut mode so existing bytes are
unchanged: `fields` carries the projection in column order, and `groupBy` appears when
`results` holds group objects.

```jsonc
// flat
{ "kind": "documents", "count": 12, "fields": ["file", "title"],
  "results": [{ "file": "docs/api.md", "title": "API" }] }

// grouped
{ "kind": "tasks", "count": 3, "fields": ["file", "line", "checked", "text"],
  "groupBy": "frontmatter.owner",
  "results": [{ "key": "alice", "count": 4, "rows": [] }],
  "summary": { "matched": 6, "groups": 3 } }
```

An array-valued group key **fans out** — one group per element — because that is the point of
grouping on tags. As a consequence, group counts can sum to more than `summary.matched`.

Group keys sort by byte order, with missing keys last. `--select` decides which keys a row
carries, so the published schema's row shape requires none of them while still type-checking
the ones it knows.

Text output is a padded column table; an empty result prints the predicates that ran, so a
query that matched nothing still shows what it asked for. The shortcut kinds keep their
existing one-JSON-object-per-line text form.

## Options

| Option                       | Default             | Description                                          |
| ---------------------------- | ------------------- | ---------------------------------------------------- |
| `--format <fmt>`             | Project default     | `llm`, `human`, or `json`.                           |
| `--paths <style>`            | Project default     | `absolute` or `relative`.                            |
| `--where <predicate>`        | None                | Repeatable filter predicate, AND-ed.                 |
| `--select <fields>`          | Entity defaults     | Comma-separated field list. Repeatable.              |
| `--group-by <field>`         | None                | Group rows by one field.                             |
| `--target <path>`            | None                | Target path and optional `#fragment` for `links-to`. |
| `--field <field>`            | `title`             | Duplicate field.                                     |
| `--lang <language>`          | Any                 | Code-block language filter.                          |
| `--content` / `--no-content` | `false`             | Include or exclude code-block bodies.                |
| `--status <status>`          | `all`               | `all`, `done`, or `pending` tasks.                   |
| `--summary` / `--no-summary` | `false`             | Show task totals or individual tasks.                |
| `--asset-extension <ext>`    | `assets.extensions` | Repeatable asset-extension override.                 |
| `--include <glob>`           | `files.include`     | Repeatable include glob.                             |
| `--exclude <glob>`           | `files.exclude`     | Repeatable exclude glob.                             |
| `-h`, `--help`               | —                   | Show help.                                           |

Shortcut options (`--target`, `--field`, `--lang`, `--content`, `--status`, `--summary`,
`--asset-extension`) cannot be combined with a composable option; doing so is an error rather
than a silently ignored flag.

`--where`, `--select`, and `--group-by` are **not configurable**. A checked-in
`commands.query.where` would silently filter every query anyone ran in the workspace, and
predicates are per-question by nature.

## Errors

All of these exit `1` with an empty stdout. Nothing ever returns zero rows because of a typo:

- An unknown entity, or a shortcut kind given a composable option.
- An unknown field in `--where`, `--select`, or `--group-by`.
- An unknown predicate name, or `links-to:` on an entity that does not support it.
- A numeric operator on a non-numeric field, or an operand of the wrong type.
- A shortcut option combined with a composable one.
