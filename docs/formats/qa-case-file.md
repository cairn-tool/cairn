# QA case file

`<runs-dir>/_plans/tc-<N>.yaml` — one test case: its identity, how it should be run, and the plan
handed to the agent verbatim. Read by [`qa run`](../commands/qa/run.md),
[`qa list`](../commands/qa/list.md) and [`qa summary`](../commands/qa/summary.md).

Authors own this file. Cairn never writes one.

## Shape

```yaml
id: TC-24 # required; must match the filename
name: The Ceiling and RoundingPoint cliffs # required; the tracker's Title column
agent: cursor # optional; cursor, claude-code, or codex
model: composer-2.5 # optional; falls back to the backend default or --model
parallel: true # optional; default true
tags: [cli, build] # optional; only with parallel: false
plan: | # required; handed to the agent verbatim
  # TC-24 — the plan, in full
  ...
```

## Keys

| Key        | Required | Type            |                                                                          |
| ---------- | -------- | --------------- | ------------------------------------------------------------------------ |
| `id`       | yes      | string          | `TC-<digits>`, case-insensitive. Its number must equal the filename's.   |
| `name`     | yes      | string          | The human title. Printed in the tracker's Title column.                  |
| `agent`    | no       | string          | The backend. One of the registered agents; defaults to the first.        |
| `model`    | no       | string          | Model slug. Omitted, the case takes its backend's default, or `--model`. |
| `parallel` | no       | boolean         | Default `true`. `false` opts the case out of unconstrained parallelism.  |
| `tags`     | no       | list of strings | Concurrency mutexes. **Only legal with `parallel: false`.**              |
| `plan`     | yes      | string          | The plan body, forwarded into the prompt unchanged.                      |

**Unknown keys are rejected.** A typo fails at load rather than defaulting silently, and every
broken file in the directory is reported at once — before any agent launches — so one
`cairn qa run --dry-run` is the complete verdict on a `_plans/` tree.

## The filename is the identity

The stem must be `tc-<digits>` exactly: lowercase `tc-`, a hyphen, then digits and nothing else.
Both `.yaml` and `.yml` are read. `tc-10a.yaml`, `TC-10.yaml` and `tc-.yaml` are not case files and
are **skipped in silence** rather than reported — a mistyped filename makes a case disappear rather
than fail, so check `cairn qa list` after adding one.

`id` is cross-checked against the stem: `tc-24.yaml` must carry `id: TC-24`. A mismatch is an error.
Two files claiming the same case — `tc-7.yaml` and `tc-7.yml` — are both refused rather than one
being guessed at.

Cases dispatch in numeric order, so `tc-2` precedes `tc-10`.

## Concurrency

| Declaration                    | Behaviour                                                                                                     |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------- |
| `parallel: true`               | Unconstrained; runs whenever a slot is free. `tags:` is not allowed.                                          |
| `parallel: false` with `tags:` | Each tag is a mutex: at most one running case holds a given tag. Cases sharing no tag still run side by side. |
| `parallel: false`, no tags     | A barrier. The queue drains to zero agents, the case runs alone, then resumes.                                |

A tag names the resource it protects — a port, a fixture directory, a shared build output — not the
case. `--parallel` is the global ceiling above all of this.

## The plan travels in the prompt

`plan` is inlined into the agent's argv rather than referenced as a file, so nothing is written to
the runs directory before the agent starts. That bounds it: a plan over **256 KiB** (`MAX_PROMPT_BYTES`)
is refused at load with the file named, rather than dying at spawn with `E2BIG`.

Use a literal block scalar (`|`). A folded scalar (`>`) reflows the plan, which changes Markdown
that depends on its own line breaks.

The harness supplies the plan as its complete case briefing — it provides no skill invocation,
prior conversation, or memory of how the case was written. A backend may still load its normal
user/project configuration and rules. Plans are therefore self-contained by design; see the
[`cairn-qa` plugin](../plugins/cairn-qa.md) for the standard governing their structure.

## What the harness validates, and what it does not

The loader checks this schema and nothing else. The plan body is prose it accepts in any shape at
all: the section structure, the quoted expectations, the artifact naming and the embedded record
skeletons are conventions a reader enforces, not the parser.

## Versioning

None. The case file carries no version key. Its shape is fixed as published contract — see
[the machine-readable result contract](../contract.md) for how cairn's declared surfaces change.

## Related

- [`qa run`](../commands/qa/run.md) — the queue, the backends, and every flag.
- [Shared QA behavior](../commands/qa/common.md) — POSIX, logs, configuration.
- [QA guide](../guide/qa.md) — why the toolset exists.
- [`cairn-qa` plugin](../plugins/cairn-qa.md) — the authoring standards, as skills.
