---
name: md-fix
description: Preview and apply cairn's deterministic Markdown fixes.
---

# Fix Markdown

Apply `cairn md fix` to `the invocation arguments from the user's message`, or to the current directory when no path is given.

1. Run `cairn md fix <path> --dry-run` and show the plan.
2. Ask the user to confirm before writing. **Do not skip this** — `md fix --write` edits tracked
   files.
3. On confirmation, run `cairn md fix <path> --write`.
4. Re-run `cairn md lint-dir <path> --summary` and report what remains.

`--write` applies every edit as one transaction and refuses entirely on any conflict, so a failed
run leaves the tree untouched.
