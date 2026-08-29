# 001. Target Conformance Profiles and `agent doctor`

| Priority | Effort | Status  |
| -------- | ------ | ------- |
| P0       | Medium | Shipped |

**Payoff:** Prevent silently stale or invalid generated plugins.

Delivered by [`agent doctor`](../../commands/agent-doctor.md) and [`agent
specs`](../../commands/agent-specs.md). The proposal below is the original text; where the
implementation diverged, the command's own documentation is authoritative.

**Command sketch:**

```text
cairn agent doctor --target all
cairn agent doctor ./bundle --target codex --host-version 1.2.3
cairn agent specs --format json
```

The converter currently encodes platform behavior directly in parser and renderer code.
That worked for the first implementation, but plugin surfaces are changing quickly. Codex
plugins now have richer install metadata and marketplace wiring; Claude Code documents more
component types and native validation commands; Cursor now treats plugins as a first-class
bundle of skills, subagents, MCP servers, hooks, and rules.

Create a versioned, data-driven capability profile for every target. It should describe:

- Supported manifest fields, default paths, component types, hook events, placeholders,
  model/tool metadata, and profile restrictions.
- Whether a mapping is exact, approximate, unsupported, or target-native pass-through.
- The target documentation revision or minimum host version used to define the profile.
- Fixture plugins and expected native layouts for conformance tests.

`agent doctor` would check a bundle and generated output against those profiles, report an
unknown/newer installed host version, and optionally invoke a host's own read-only validator
when installed. Native validators must be additive evidence; output should remain useful on
machines where the hosts are absent.

This is the best P0 investment because every other agent feature depends on knowing that
generated artifacts are current. It also makes adding a target an adapter-and-fixtures task
rather than another set of conditionals in one renderer.

---

[Back to the idea index](_contents.md)
