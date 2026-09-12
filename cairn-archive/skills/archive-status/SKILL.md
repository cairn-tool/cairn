---
name: archive-status
description: Report what a cairn archive holds.
---

# Archive status

Run `cairn archive status`, forwarding `--archive <dir>` if `the invocation arguments from the user's message` supplies one.

Report the totals plainly: how many artifacts of each class, how many segments, and the size on
disk. Then say whether a `cairn archive run` looks worth doing.

Do not run `archive run` from here — it writes, potentially a great deal.
