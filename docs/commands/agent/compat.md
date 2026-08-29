# `agent compat`

## Synopsis

```text
cairn agent compat [source] [options]
```

Without `source`, prints the general platform compatibility matrix. With `source`, analyzes
that bundle and identifies exact, approximate, unsupported, or target-specific mappings.

The matrix is a one-line-per-component summary generated from the target conformance
profiles. For the full machine-readable profiles use [`agent specs`](specs.md); to
check a bundle and its generated output against them use [`agent doctor`](doctor.md).

## Arguments

| Argument | Required | Description                                                                   |
| -------- | -------- | ----------------------------------------------------------------------------- |
| `source` | No       | Optional bundle root to analyze. Omit it for the static compatibility matrix. |

## Options

| Option              | Default                | Description                                                                               |
| ------------------- | ---------------------- | ----------------------------------------------------------------------------------------- |
| `--target <target>` | All applicable targets | Repeatable target: `claude-code`, `codex`, `cursor`, `antigravity`, `opencode`, or `all`. |
| `--strict`          | Off                    | Treat approximations as blocking findings.                                                |
| `--format <fmt>`    | `llm`                  | Output as `llm`, `human`, or `json`. Shorthands: `-fh`, `-fj`.                            |
| `-h`, `--help`      | —                      | Show help.                                                                                |

Compatibility findings use exit `2`; invocation and I/O errors use exit `1`.
