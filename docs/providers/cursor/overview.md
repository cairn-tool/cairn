# Cursor

An editor rather than a CLI, and the only provider here that fills exactly one role: it is a
conversion target, and nothing else.

| Role              | Supported | Identifier | Declared in                   |
| ----------------- | --------- | ---------- | ----------------------------- |
| Conversion target | yes       | `cursor`   | `src/agent/targets/cursor.ts` |
| Usage log source  | **no**    | —          | deliberately unregistered     |
| Archive source    | **no**    | —          | follows from the above        |

## Where things live

Cairn writes to two Cursor surfaces and reads from neither.

```text
~/.cursor/plugins/local/<bundle>/      user-scope plugin install

<project>/
  .cursor/skills/<name>/SKILL.md
  .cursor/agents/<name>.md
  .cursor/rules/<name>.mdc
  .cursor/hooks.json
  .cursor/mcp.json
```

A plugin-profile render also emits `.cursor/rules/<name>.mdc` **inside the plugin tree**, which
is the one place a rule reaches a Cursor plugin at all.

## Host profile

| Field                   | Value              |
| ----------------------- | ------------------ |
| `displayName`           | `Cursor`           |
| `documentationRevision` | `2026-08-02`       |
| `minimumVersion`        | not recorded       |
| `verifiedThrough`       | not recorded       |
| `versionCommand`        | `cursor --version` |
| `nativeValidator`       | none declared      |

## Pages

- [Agent bundles](agent-bundles.md) — the conversion target profile in full
- [Usage logs](usage-logs.md) — why there is no usage provider
- [Archiving](archiving.md) — why there are no artifact sets

## Caveats worth knowing up front

- **Plugin skill directories are namespaced** as `skills/<bundle>-<skill>/`. Cursor is the only
  target that does this, and it is why its `skills` feature is `approximate` rather than
  `exact` despite otherwise rendering identically.
- **The hook document has a different shape** from Claude Code's and Codex's: camelCase event
  names, a `{ version: 1, hooks }` envelope, and flat handlers with no `{ matcher, hooks: [] }`
  nesting.
- **Command policies are unsupported.** Cursor has no permission surface; a policy converts
  only through an explicit hook override, and is otherwise reported and dropped.
- **`~/.cursor` on a machine without Cursor holds only third-party hook configuration**, which
  is the reason there is no usage provider — see [Usage logs](usage-logs.md).
