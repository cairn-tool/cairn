# `usage projects`

## Synopsis

```text
claude-cli usage projects [options]
```

Usage rolled up by the working directory each session ran in.

## Options

| Option                                           | Default | Description                                                                                                                                               |
| ------------------------------------------------ | ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Shared options](usage-common.md#common-options) | —       | `--format`, `--envelope`, `--provider`, `--project`, `--since`, `--until`, `--last`, `--top`, `--logs`, `--no-subagents`, `--no-index`, `--strict`, `-h`. |

## Project identity

A project is the `cwd` recorded inside the transcripts, not the log directory name. That name
is the path with both separators and underscores replaced, which makes it lossy and not
reliably invertible, so it is never used as an identity.

Transcripts with no recorded working directory are grouped under `(unknown)` rather than
dropped.

Use `--project` to narrow to one; see [shared behavior](usage-common.md) for what that
selector accepts.

## Exit codes

| Condition                                                     | Code | Stream |
| ------------------------------------------------------------- | ---- | ------ |
| Report written                                                | `0`  | stdout |
| Invocation error, or no logs found                            | `1`  | stderr |
| `--strict` was given and a transcript could not be fully read | `2`  | stderr |

## Related surfaces

- [`usage sessions`](usage-sessions.md) reports the same activity one session at a time.
- [`usage tokens`](usage-tokens.md) breaks the same tokens down by model, time, project, or session.
- [Shared usage command behavior](usage-common.md) documents log discovery, counting, windows, project selection, and the scan cache.
