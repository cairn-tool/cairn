# OpenCode

The open-source OpenCode CLI, and the second assistant Cairn fills all three roles for.

| Role              | Supported | Identifier | Declared in                       |
| ----------------- | --------- | ---------- | --------------------------------- |
| Conversion target | yes       | `opencode` | `src/agent/targets/opencode.ts`   |
| Usage log source  | yes       | `opencode` | `src/usage/providers/opencode.ts` |
| Archive source    | yes       | `opencode` | `src/archive/sets.ts`             |

It is unusual in two ways. It is the only registered assistant that keeps **every session in one
SQLite database** rather than a file per conversation, and it is the only one that **reports its
own usage**, which gives this provider something independent to check its figures against.

## Where things live

`$XDG_DATA_HOME/opencode`, or `~/.local/share/opencode`.

```text
~/.local/share/opencode/
  opencode.db                    sessions, messages, parts, projects
  opencode.db-wal, -shm          live write sidecars
  log/<ISO>.log                  CLI logs
  storage/session_diff/*.json    per-session file diffs
  snapshot/<hash>/<hash>/        a bare git repository per snapshot
```

Configuration is elsewhere, at `~/.config/opencode/` — **not** `~/.opencode/`, which OpenCode
does not read.

## Everything the parser needs is verified

`opencode` was installed while this provider was written, so every figure it produces was checked
against the host's own reporting rather than inferred:

```bash
opencode stats                    # tokens, cost, and per-tool totals
opencode export <session id>      # one session as JSON
```

`cairn usage summary --provider opencode` reproduces `opencode stats` exactly — sessions, input,
output, cache, and all four tool names and counts. That is the standard this directory asks for,
and OpenCode is the one provider that can meet it directly.

## Pages

- [Agent bundles](agent-bundles.md) — the conversion target profile
- [Usage logs](usage-logs.md) — the store, and the three grains it records usage at
- [Archiving](archiving.md) — the artifact sets `archive run` collects

## Caveats worth knowing up front

- **The same usage is written three times** — on the message, on its `step-finish` part, and on
  the session rollup. Reading two of them doubles every figure exactly.
- **Unknown top-level keys in `opencode.json` are rejected** and the host refuses to start, which
  is why no bundle manifest is ever written there.
- OpenCode 1.18.23 has **no lifecycle hook file**. Plugins are TypeScript callbacks, which a
  portable hook declaration cannot express.
