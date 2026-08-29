# 014. Read-Only MCP Server

| Priority | Effort | Status  |
| -------- | ------ | ------- |
| P2       | Medium | Shipped |

**Payoff:** Expose the workspace engine directly to agent hosts.

Delivered by [`serve`](../../commands/serve.md). The proposal below is the original text; where
the implementation diverged, the command's own documentation is authoritative.

Deviation: the `--allow-refactors` flag in the sketch below was deliberately not implemented.
The server is read-only by construction, with no write path in the process, rather than
read-only by default.

**Command sketch:**

```text
cairn serve mcp --root docs
cairn serve mcp --root . --allow-refactors
```

Expose the deterministic workspace engine as MCP tools such as `list_documents`,
`get_section`, `query_workspace`, `build_context`, `inspect_graph`, and `audit_markdown`.
This removes shell-output parsing for compatible hosts while retaining the same core result
types.

The default server should be read-only, local, and stdio-based. Refactor tools should be
disabled unless explicitly allowed and should return a plan before applying changes. Keep the
server thin: it should call the same library functions as the CLI, not spawn the binary or
reimplement command behavior.

---

[Back to the idea index](_contents.md)
