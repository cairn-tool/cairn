# `completion`

## Synopsis

```text
cairn completion <shell>
```

Prints a shell completion script to stdout. The script is generated from the same command tree
[`describe`](describe.md) walks, so it cannot drift from the real commands and options.

## Arguments

| Argument | Required | Description                             |
| -------- | -------- | --------------------------------------- |
| `shell`  | Yes      | `bash`, `zsh`, `fish`, or `powershell`. |

## Options

| Option           | Default | Description                                                 |
| ---------------- | ------- | ----------------------------------------------------------- |
| `--format <fmt>` | `llm`   | Accepted for consistency; the script is written either way. |
| `-h`, `--help`   | —       | Show help.                                                  |

`--format` is validated but does not change the output, the same way `schema <id>` writes its
document regardless of format. The script **is** the payload, and `describe --format json`
already publishes the command tree it is generated from.

## Installing

```bash
cairn completion bash       >> ~/.bashrc
cairn completion zsh        > ~/.zfunc/_cairn    # a directory on $fpath
cairn completion fish       > ~/.config/fish/completions/cairn.fish
cairn completion powershell >> $PROFILE
```

The command never writes to a shell profile itself; redirection is yours to choose.

Regenerate after upgrading. The script embeds the command tree rather than calling back into
the CLI, so a stale script describes a stale CLI — it carries the generating version in a
header comment for exactly this reason. The version appears **only** in that comment, so the
script body does not churn on every release.

## What gets completed

| Position                    | Offered                                                           |
| --------------------------- | ----------------------------------------------------------------- |
| A command position          | Subcommands, plus that command's flags.                           |
| A fixed-vocabulary argument | Its values, for example `md query <kind>` or `agent add <kind>`.  |
| `--format`                  | The formats **that command** accepts, read from the contract.     |
| An enumerated option value  | Its values, for example `md graph --output report\|mermaid\|dot`. |
| A file or directory value   | Delegated to the shell's own path completion.                     |

Because `--format` values come from the command contract rather than a fixed list,
`md audit --format` offers `jsonl` and `sarif` while `md graph --format` does not.

Repeatable options stay offered after use; hidden commands, including the internal cache
refresh, never appear.

## Why a static script

The script embeds the command tree instead of calling back into the CLI. A callback would
spawn a Node process on every Tab press, and would need a hidden command — CLI surface that
behaves like an API while being excluded from `describe` by construction. Nothing being
completed is dynamic, and file completion is better handled by the shell's own builtins, so
there is nothing to gain in exchange.

## Update notices

The update notice is suppressed for this command. The `eval "$(cairn completion zsh)"`
idiom runs from an interactive rc file, where stderr **is** a TTY — without the suppression the
notice would print on every shell start and a background refresh would spawn on every shell
start. See [the contract](../contract.md).

## Exit codes

| Code | Meaning                                  |
| ---- | ---------------------------------------- |
| `0`  | Script written to stdout.                |
| `1`  | Unknown shell, or an invalid `--format`. |
