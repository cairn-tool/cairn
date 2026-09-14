# Working with the cairn CLI

Shared conventions for every `cairn` command. Read this when a command behaves unexpectedly, or
when you need output another tool will parse.

## The binary must already be installed

`cairn` is published as `@cairn-tool/cairn` on the public npm registry. Nothing here installs
it. If `command -v cairn` finds nothing, say so and stop — do not install it yourself, and do
not fall back to `npx`, which resolves an unpinned version on every run.

Installing it is one command, and needs no registry configuration and no token:

```bash
npm install -g @cairn-tool/cairn
```

## Output formats

Every command takes `--format llm|human|json`, with `-fh` and `-fj` as shorthands.

| Format  | Use it for                                                      |
| ------- | --------------------------------------------------------------- |
| `llm`   | The default. Compact, stable, meant to be read in a transcript. |
| `human` | Wider, aligned output for a terminal a person is watching.      |
| `json`  | Anything you are going to filter, count, or feed to `jq`.       |

Prefer `-fj` whenever you intend to extract a specific field. Parsing the `llm` rendering is
never necessary and its exact spacing is not a contract.

`--envelope` wraps `--format json` output in a versioned result envelope carrying the tool name,
version, and exit code. Use it only when a consumer asked for it.

A few commands add more: the diagnostic commands also accept `--format sarif`, and
`md lint`/`md lint-dir` accept `--format jsonl`.

## Exit codes

| Code | Meaning                                                                     |
| ---- | --------------------------------------------------------------------------- |
| `0`  | Success, or an informational query that completed.                          |
| `1`  | Usage, configuration, filesystem, or network error. **You made a mistake.** |
| `2`  | Actionable findings. **The command worked; the content has problems.**      |

Exit `2` is not a failure of the command. Treat it as the answer, not as an error to retry.
`scripts run` is the one exception: it forwards the child process's own exit status.

## Where output goes

For `--format json`, a clean run writes to stdout. A run reporting findings may write to
**stderr** instead, depending on the command. Capture both when scripting.

## Workspace configuration

`md` commands look for a `.cairn.yml` in the working directory, then each ancestor. The
directory holding it becomes the workspace root, and paths outside that root are refused. The
pre-rename name `.claude-cli.yml` is still read.

`--config <file>` selects one explicitly; `--no-config` disables discovery. They are mutually
exclusive. If a command reports "outside configured workspace root", a config file above you is
narrowing the workspace — that is the file to look at.

## Paths in output

`--paths absolute|relative` selects how paths are reported. Relative paths are resolved against
the workspace root, not the working directory.
