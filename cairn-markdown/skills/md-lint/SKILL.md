---
name: md-lint
description: Lint a Markdown file or directory with cairn.
---

# Lint Markdown

Run `cairn md lint` on `the invocation arguments from the user's message`, or on the current directory when no path is given.

1. If `the invocation arguments from the user's message` is empty, use `cairn md lint-dir . --summary`.
2. If it names a directory, use `cairn md lint-dir <dir> --summary`.
3. If it names one or more files, use `cairn md lint <files...>`.

Pass `--style` through if the user included it. Exit `2` means findings, not failure.

Report the findings grouped by file, highest count first. Do not fix anything unless asked.
