# Shared Markdown command behavior

All commands below `cairn md` participate in project configuration and workspace path
resolution. Configuration discovery walks upward from the current directory looking for
`.cairn.yml`. Use `cairn md --config <file> <command>` to select a file explicitly,
or `cairn md --no-config <command>` to use built-in defaults.

## Common options

Every `md` leaf command exposes these options. Individual command pages list them again for
completeness.

| Option                | Values                                                                                | Behavior                                                                    |
| --------------------- | ------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| `--format <fmt>`      | `llm`, `human`, `json`; aggregate diagnostic commands also accept `jsonl` and `sarif` | Select output rendering. The project default is `llm`.                      |
| `--paths <style>`     | `absolute`, `relative`                                                                | Control paths in output. The project default is `absolute`.                 |
| `--stdin-name <path>` | Workspace path                                                                        | Give input read from `-` a logical path for relative references and output. |
| `-h`, `--help`        | —                                                                                     | Show command help.                                                          |

`-fh` expands to `--format=human` and `-fj` expands to `--format=json` before argument parsing.
`jsonl` and `sarif` are supported only by `lint`, `lint-dir`, `audit`, `check-urls`, and
`validate-frontmatter`.

## Precedence and lists

Option values resolve in this order, from highest to lowest priority:

1. Explicit CLI option.
2. `commands.<command>.<option>` in `.cairn.yml`.
3. Relevant top-level project setting.
4. Built-in command default.

Command configuration uses camel-case names such as `maxDepth`, `brokenOnly`, and
`changedSince`. A repeatable list supplied on the CLI replaces the configured list rather
than appending to it.

## Input and workspace rules

- Commands that accept `-` can read Markdown from stdin. Use `--stdin-name` when relative
  references or a stable reported path matter.
- Directory selection always ignores `.git` and `node_modules`; directory symlinks are not
  followed.
- `--include` and `--exclude` are repeatable minimatch globs and override configured lists.
- `--changed-since <revision>` intersects selected inputs with changed and untracked Git files.
- Machine-readable success payloads go to stdout. Diagnostic payloads that cause exit `2`
  go to stderr, including JSON, JSONL, and SARIF.
