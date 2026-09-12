---
name: qa-case-plan
description: The standard for a cairn qa test case — the `_plans/tc-N.yaml` case file with its seven keys and its parallel/tags concurrency declaration, and the numbered plan document the running agent receives as its entire briefing, including the quoted-expectation rule and the artifact naming the tracker parses. Use when writing, reading, or judging a test case plan or a case file, when deciding whether a case may run in parallel or what to tag it, or when asked to add or check a case under a `_plans/` directory.
---

# The cairn qa test case

Read the two reference documents in full before writing or judging a case — they are the actual
specification, not this file. This file says how to apply them and where they stop.

- [`reference/case-file.md`](reference/case-file.md) — the YAML: the seven keys, the filename and
  `id` cross-checks, the block scalar, and how to choose `model`, `parallel` and `tags`.
- [`reference/plan.md`](reference/plan.md) — the document: §0 through §13, what each section holds,
  and the rules that make a record readable by the tracker.

The record shapes a plan embeds in §11 belong to the **qa-run-record** skill in this same bundle.
Read its reference documents before writing §11. The CLI that runs all this is **qa-runner**.

## The one rule the rest is built around

**The expected values come from the source document. Neither the plan author nor the runner supplies
them.**

An agent asked to check that a value is right will recompute it from the formula, agree with itself,
and produce a record that looks immaculate and proves nothing. So every Expected cell is a quotation
carrying its citation, pre-seeded by the author from whatever document actually states the expected
behaviour — a specification, a ticket, a QA step document. The runner verifies each quotation against
the cited source and records what was observed. It does not re-derive the expectation, and it does
not trust the plan blindly either.

**Never edit an expectation to match an observation.** A disagreement is a finding, not an
expectation to adjust. Everything else in the standard exists to make that rule survive contact with
a real run: §3 names the source, §8 makes the observation attributable, §10 makes it citable, and
§11's attestations make the runner say plainly that they did it.

## The plan is the agent's entire briefing

`cairn qa run` passes the plan to the backend as a single argv string. The harness supplies no skill
invocation, prior conversation, or memory of how the case was written; a backend may still load its
normal user/project configuration and rules. So a plan repeats its rules and embeds both record
skeletons rather than pointing at them — roughly a third of its length. That looks redundant and is
not: slimming it would depend on the repository under test having this plugin installed and enabled,
which the harness cannot verify and whose absence would degrade every run silently.

## Scope: the shape applies everywhere, the destination does not

Apply every section of both standards **except the path conventions** — that a case file lives at
`<runs-dir>/_plans/tc-<N>.yaml` and that deliverables land in `<runs-dir>/tc-<N>/`.

Everywhere else — a plan drafted in conversation, a case pasted into a ticket, a file the user named
— the schema, the section skeleton, the quotation rule and the artifact naming still apply, and the
path rule does not. **Never invent an output path, and never create a file that was not asked for**,
to satisfy this standard.

**Never create a `tc-<N>/` run folder.** Its absence is what marks the case as pending; the harness
creates it by promoting a successful run. Writing one removes the case from the queue while leaving
nothing that ran.

## Where the repository wins

A standard that hard-codes one project's build rules works in one repository. What must never be
built, the sanctioned way to launch each surface, which conflict tags exist and what each protects,
the default model — all of that differs per repository and belongs in the repository, whether in a
`TC-HARNESS.md` profile at its root or in its existing plans and contributor docs. **Where the
repository and this standard disagree, the repository is right.**

When none of it is written down, say so and read the rules from the project's existing plans. Never
invent a build rule, a launch command, a port, or a tag.

## Prove it loads

```bash
cairn qa run --repo . --runs-dir <dir> --dry-run
```

Every broken file in the directory is reported at once, before any agent launches, so one dry run is
the complete verdict on a `_plans/` tree. It validates the **file**, not the plan: the sections, the
quoted expectations and the artifact naming are prose the harness accepts in any shape at all.

## What gets gotten wrong

1. **An expectation quietly rewritten** to match what was observed. This is the failure the whole
   standard exists to prevent, and it produces a clean-looking record that proves nothing.
2. **A filename the harness ignores.** `tc-10a.yaml`, `TC-10.yaml` and `tc-.yaml` are not case files
   and are skipped in silence. Check `cairn qa list` after adding cases.
3. **`tags:` on a `parallel: true` case.** Rejected at load: tags only constrain a case that has
   already opted out of unconstrained parallelism.
4. **`id:` disagreeing with the filename.** `tc-24.yaml` must carry `id: TC-24`. The mismatch is an
   error, not a warning.
5. **A plan over the size cap.** The plan travels inside the prompt argv, so it is bounded at
   256 KiB and a larger one fails at load with the file named.
6. **Inventing the build rule.** If the repository does not say how to launch the thing under test,
   the answer is to ask, not to guess — a plan that tells an agent to do what the project forbids is
   worse than no plan.
