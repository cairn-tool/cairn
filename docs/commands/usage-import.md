# `usage import`

## Synopsis

```text
cairn usage import [options]
```

Imports transcripts into the usage store.

## Options

| Option                                           | Default | Description                                                                                                                                               |
| ------------------------------------------------ | ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--rebuild`                                      | —       | Re-parse every transcript, not only the ones that changed.                                                                                                |
| [Shared options](usage-common.md#common-options) | —       | `--format`, `--envelope`, `--provider`, `--project`, `--since`, `--until`, `--last`, `--top`, `--logs`, `--no-subagents`, `--no-index`, `--strict`, `-h`. |

## Why it exists

Reports populate the store on first use, so this is never required to get a number out. It exists
to do that work deliberately:

- to warm a cold store before a timed report, so the first run is not the slow one
- to run on a schedule, keeping the store current without anyone asking for a report
- to see the import counters on their own, rather than in the `scan` block of a report

The first import of a large corpus reads every transcript once; later ones open only the files
that grew. Over a corpus of roughly ten thousand transcripts and nine gigabytes, that is the
difference between about a minute and under a second.

## What gets written

Two grains, from one parse:

- the day rollup every report reads
- the per-occurrence `event` rows that answer what a day bucket cannot

See [the store](usage-common.md#the-usage-store) for what each is for and how to query the
second.

`--since` and `--no-subagents` prune the walk, so an import given either may only insert and
update. Only an unfiltered import may drop rows for transcripts that are gone, because only then
does a file's absence prove anything.

## Exit codes

| Condition                                                     | Code | Stream |
| ------------------------------------------------------------- | ---- | ------ |
| Import completed                                              | `0`  | stdout |
| Invocation error, or no logs found                            | `1`  | stderr |
| `--strict` was given and a transcript could not be fully read | `2`  | stderr |

## Related surfaces

- [`usage index`](usage-index.md) reports on the store this fills.
- [`usage migrate`](usage-migrate.md) moves the store between schema versions.
- [Shared usage command behavior](usage-common.md) documents log discovery, counting, windows, project selection, and the store.
