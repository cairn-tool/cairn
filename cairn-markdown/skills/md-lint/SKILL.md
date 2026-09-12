---
name: md-lint
description: Lint a Markdown file or directory with cairn.
disable-model-invocation: true
argument-hint: "[path] [--style]"
---

# Lint Markdown

Run `cairn md lint` on `$ARGUMENTS`, or on the current directory when no path is given.

1. If `$ARGUMENTS` is empty, use `cairn md lint-dir . --summary`.
2. If it names a directory, use `cairn md lint-dir <dir> --summary`.
3. If it names one or more files, use `cairn md lint <files...>`.

Pass `--style` through if the user included it. Exit `2` means findings, not failure.

Report the findings grouped by file, highest count first. Do not fix anything unless asked.
