---
name: agent-new
description: Scaffold a new portable agent bundle with cairn.
argument-hint: <name> [--component skill|agent|hook|mcp]
---

# New agent bundle

Scaffold a bundle named in `$ARGUMENTS`.

1. Run `cairn agent init <name> --dry-run` and show the plan.
2. On confirmation, run it for real, passing through any `--component` flags. Default to
   `--component skill` if none were given.
3. **Fill in `marketplace.publisher.name` immediately.** `agent init` leaves it empty, which
   validates cleanly but fails later as `AB500` the first time the bundle is packaged.
4. Finish with `cairn agent validate <name> --target all` and report the result.

Do not add components the user did not ask for.
