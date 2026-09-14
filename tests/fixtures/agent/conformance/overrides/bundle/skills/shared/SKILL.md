---
name: shared
description: Available everywhere
targets:
  codex:
    description: Available everywhere (codex wording)
---
Shared body.

<!-- if target:claude-code -->
Claude-specific paragraph.
<!-- elif platform:codex -->
Codex-specific paragraph.
<!-- else -->
Paragraph for every other host.
<!-- endif -->
