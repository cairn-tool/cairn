# 002. Versioned Machine-Readable Result Contracts

| Priority | Effort | Status  |
| -------- | ------ | ------- |
| P0       | Medium | Shipped |

**Payoff:** Make the CLI a dependable API for agents and CI.

Delivered by [`describe`](../../commands/describe.md) and [`schema`](../../commands/schema.md).
The proposal below is the original text; where the implementation diverged, the command's own
documentation is authoritative.

**Command sketch:**

```text
cairn describe
cairn describe md graph --format json
cairn schema agent-result
```

JSON output is already important, but each command currently owns its own result shape.
Publish versioned JSON Schemas and a self-description command that exposes commands, options,
exit semantics, supported formats, and output schema IDs. Add a common envelope where it does
not break useful command-specific data:

```json
{
  "schemaVersion": "1",
  "command": "md graph",
  "ok": false,
  "findings": [],
  "summary": {}
}
```

The initial release does not need to redesign every payload. It can document current shapes,
add schema identifiers, and make future compatibility rules explicit. This would let agents
discover the CLI instead of scraping `--help`, let CI validate payloads, and make an MCP or
library wrapper much safer to build. The update notifier's machine-stream guarantees must
remain part of this contract.

---

[Back to the idea index](_contents.md)
