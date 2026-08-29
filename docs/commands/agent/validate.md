# `agent validate`

## Synopsis

```text
cairn agent validate <source> [options]
```

Loads and validates a portable agent bundle without generating output. It checks the bundle
manifest, component metadata, internal paths, references, overrides, conditionals, hooks,
policies, and other normalized model constraints. Supplying targets also validates target
mappings and reports compatibility diagnostics.

## Arguments

| Argument | Required | Description                     |
| -------- | -------- | ------------------------------- |
| `source` | Yes      | Root of the bundle to validate. |

## Options

| Option              | Default | Description                                                                                                   |
| ------------------- | ------- | ------------------------------------------------------------------------------------------------------------- |
| `--target <target>` | None    | Repeatable target mapping to validate: `claude-code`, `codex`, `cursor`, `antigravity`, `opencode`, or `all`. |
| `--strict`          | Off     | Promote approximations to blocking findings.                                                                  |
| `--format <fmt>`    | `llm`   | Output as `llm`, `human`, or `json`. Shorthands: `-fh`, `-fj`.                                                |
| `-h`, `--help`      | —       | Show help.                                                                                                    |

Exit `0` means validation passed. Exit `1` is an invocation or I/O error. Exit `2` means the
bundle has validation, compatibility, or strict-mode findings.
