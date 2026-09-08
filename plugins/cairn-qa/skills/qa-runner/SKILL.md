---
name: qa-runner
description: Run a queue of TC-N test-case plans with the cairn qa toolset, across Cursor and Claude Code backends. Use when asked to run, dispatch, preview, or re-run test cases, when a queue needs its status checked, or when summary.md has to be regenerated from what is on disk.
---

# Running a test-case queue with cairn

Confirm the toolset exists before relying on it: `cairn describe qa -fj` lists the three subcommands.
If the group is absent, the installed cairn predates this feature — say so and stop rather than
guessing at flags. All three are `stability: experimental`, so read payload shapes through
`cairn describe` and `cairn schema qa-result` rather than hardcoding them.

## This one executes things

`qa run` discovers `_plans/tc-N.yaml` under `--runs-dir`, inlines each plan into a prompt, and spawns
the case's agent backend **with permission checks bypassed** — `--force --trust` for Cursor,
`--dangerously-skip-permissions` for Claude Code. The agent can write wherever the case tells it to.

That is a different trust boundary from `cairn scripts run`, which resolves a name declared in a
tracked `.cairn.yml`. Here the plans are discovered in a directory you point at, and their bodies are
forwarded to an agent. **Never launch a queue you have not read**, and prefer `--dry-run` when the
plans came from anywhere but the user.

## The three commands

```bash
cairn qa list --repo . --runs-dir work/tc-runs              # what is pending, what is done
cairn qa run  --repo . --runs-dir work/tc-runs --dry-run    # the queue and the argv; launch nothing
cairn qa run  --repo . --runs-dir work/tc-runs              # dispatch
cairn qa summary --runs-dir work/tc-runs                    # rebuild summary.md from disk
```

**Look before you launch.** `--dry-run` prints each case's model, its concurrency constraint, and the
full command line, without spawning anything. Add `--show-prompts` to see each prompt un-elided. It
needs no agent installed, so it is safe on any machine.

`--repo` is required on `qa run` and is the agent's working directory. `--runs-dir` must resolve
under it. A relative `--runs-dir` resolves against `--repo` when one is given, and against the current
directory otherwise — the same rule in every subcommand.

## A case is pending exactly while its folder is missing

`<runs-dir>/tc-N/` absent means pending. The agent writes to `tc-N-temp/`, and the harness renames it
to `tc-N/` **only** after the run succeeds — exit 0 with both `_report.md` and `_results.md` present.
A crash leaves the temp folder; the next invocation deletes it and retries.

**Never create a `tc-N/` folder by hand.** It removes the case from the queue while leaving nothing
that ran — a failure with no error and no output. Re-running a finished case means deleting its
folder first, deliberately.

## Two backends in one queue

| `agent:`      | Binary                       | Default model          | Distinct flags                                               |
| ------------- | ---------------------------- | ---------------------- | ------------------------------------------------------------ |
| `cursor`      | `cursor-agent`, then `agent` | `cursor-grok-4.6-high` | `--force --trust --workspace <repo>`                         |
| `claude-code` | `claude`                     | `sonnet`               | `--verbose --dangerously-skip-permissions`, no `--workspace` |

A queue may mix them freely. PATH lookup is lazy per backend, so a cursor-only queue does not fail
because `claude` is absent. `--model slug` sets the default for every backend; `--model cursor=slug`
sets one. `--agent <path>` overrides the binary for **every** backend, which is the test hook — not
a way to point one backend somewhere else.

## Exit codes

| Code | Meaning                                                              |
| ---- | -------------------------------------------------------------------- |
| `0`  | Every started case reached `ok`, the queue was empty, or `--dry-run` |
| `1`  | Invocation, I/O, or configuration error                              |
| `2`  | At least one case failed, timed out, or produced no output           |

`2` is the interesting one and it is not an error in the tool — it means the queue ran and something
in it did not pass. Read `summary.md` or the JSON payload to say which, rather than reporting the run
itself as broken.

## Practice

1. **Dry-run first on anything unfamiliar.** One call turns "run these cases" into an informed
   decision, and it costs nothing.
2. **Report per case, not just the totals.** "14 of 16 passed; tc-7 timed out and tc-11 produced no
   `_results.md`" is the useful answer. The totals row alone hides which case to look at.
3. **Zero tokens on a backend is a symptom, not a result.** If a case reports `0` tools and `0`
   tokens but claims `ok`, the stream was not parsed — say so rather than reporting the run as clean.
4. **`--parallel` is a ceiling, not a target.** Cases declare their own constraints: `parallel: false`
   with `tags:` takes a mutex per tag, and with no tags it is a barrier that runs alone.
5. **Gitignore `<runs-dir>/_logs/`.** Agent transcripts land there and cairn writes no `.gitignore`.
   They can be large and they quote repository source.
6. **POSIX only.** Process-group signalling, `flock` and raw mode have no Windows equivalent in this
   build; `qa` exits 1 there.

## More

Full flags, the concurrency model, configuration, and the log layout are in
[`reference/running.md`](reference/running.md). The case file itself is the `qa-case-plan` skill; the
records a run leaves behind are `qa-run-record`.
