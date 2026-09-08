# QA harness

Why the `qa` toolset exists, and the two facts that make running it a deliberate act rather than a
hidden executor.

Cairn's other toolsets read files, convert them, or report on logs. A test-case plan is different:
it names an agent backend and a procedure the agent is expected to carry out against a real
repository. The `qa` toolset is the queue, the TUI, the per-case logs, and the tracker for that
work.

```bash
cairn qa list --repo . --runs-dir work/tc-runs
cairn qa run --repo . --runs-dir work/tc-runs --dry-run
cairn qa run --repo . --runs-dir work/tc-runs
cairn qa summary --runs-dir work/tc-runs
```

Two facts matter more than the flags.

**It discovers `_plans/tc-N.yaml` and inlines each plan into a prompt.** That is not
[`scripts run`](../commands/scripts/run.md). Scripts resolve a name declared in a tracked
`.cairn.yml`. QA reads plan files from a directory you point at and forwards their bodies to an
agent.

**Permission checks are bypassed.** Cursor is spawned with `--force --trust`. Claude Code is
spawned with `--dangerously-skip-permissions` (and `--verbose`, which stream-json requires). The
agent can write wherever the case asks. That is the point of an unsupervised queue, and it is why
`--repo` is required and why `--runs-dir` must sit under it.

A queue may mix `cursor` and `claude-code` cases. Each backend has its own argv, its own
stream-json dialect, and its own default model; the harness normalizes both onto the same event
shape before anything is counted. PATH lookup is lazy: a cursor-only queue does not fail because
`claude` is absent.

POSIX-only in this build. Logs land under `<runs-dir>/_logs/`; gitignore that directory — cairn
does not write a `.gitignore`.

## Related

- [`qa run`](../commands/qa/run.md) — the queue, the backends, and every flag.
- [`qa list`](../commands/qa/list.md) — pending versus done, without launching.
- [`qa summary`](../commands/qa/summary.md) — regenerate `summary.md` from disk.
- [Shared QA behavior](../commands/qa/common.md) — POSIX, logs, configuration.
