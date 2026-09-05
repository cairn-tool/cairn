---
name: md-toc
description: Generate or synchronize a Markdown table of contents with cairn.
argument-hint: <file> [--max-depth <n>]
---

# Table of contents

Work on the file named in `$ARGUMENTS`.

- If the document has `cairn:toc` markers, run `cairn md toc <file> --check` first. If it reports
  drift, show the difference, then run `--write` once the user confirms.
- If it has no markers, run `cairn md toc <file>` and give the user the generated block to paste.
  Do not insert markers into their document uninvited.

Pass through `--max-depth`, `--min-depth`, and `--ordered` if the user supplied them.
