---
name: usage-today
description: Show recent cairn usage totals.
---

# Recent usage

Run `cairn usage summary`, forwarding anything in `the invocation arguments from the user's message`. Default to `--since 7d` when no
range is given.

Then, if the summary suggests a follow-up, offer one — `usage tokens --by day` for a trend,
`usage projects` for where it went — but do not run several reports uninvited.

State the range you used. `--since` is day-granular, so "the last 7 days" means seven calendar
days, not a rolling 168 hours.
