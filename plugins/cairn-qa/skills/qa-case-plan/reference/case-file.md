# Case File Standards

The `_plans/tc-<N>.yaml` file: what the harness accepts, what it rejects, and the choices the schema
allows but does not decide for you.

## 1. Identity and filename

A case file is `<runs-dir>/_plans/tc-<N>.yaml`. `.yml` is accepted equally, but a case with **both**
extensions present is refused — both files, not one of them — with `tc-1: both tc-1.yaml and
tc-1.yml exist; keep one`. The harness will not guess which one you meant.

The stem must match `tc-<digits>` exactly: lowercase `tc-`, a hyphen, digits and nothing else.
`tc-10a.yaml`, `TC-10.yaml`, and `tc-.yaml` are not case files, and are ignored in silence rather
than reported — a mistyped filename makes a case _disappear_ rather than fail, so check
`cairn qa list` after adding cases: a plan you wrote that is not in that listing was misnamed.

Anything else in `_plans/` is ignored, so a `tc-24.md` sitting beside `tc-24.yaml` is harmless. Where
a project keeps both, the `.md` is a readable mirror for humans and diffs; only the `.yaml` is read.

Cases are ordered numerically, not lexicographically: `tc-2` dispatches before `tc-10`.

## 2. The seven keys

The top level must be a mapping. The key set is closed — exactly `id`, `name`, `agent`, `model`,
`parallel`, `tags`, `plan`. An unknown key is an error, not a warning:

```text
unknown key(s): tag (expected id, name, agent, model, parallel, tags, plan)
```

That strictness is deliberate. `tag:` for `tags:` and `paralell:` for `parallel:` would otherwise
default silently and the case would run under constraints nobody chose.

| Key        | Required | Type            | Default  | Rules                                                                          |
| ---------- | -------- | --------------- | -------- | ------------------------------------------------------------------------------ |
| `id`       | yes      | string          | —        | `TC-<digits>`, case-insensitive, trimmed. Its number must equal the filename's |
| `name`     | yes      | string          | —        | Non-empty after trimming. The human title                                      |
| `plan`     | yes      | string          | —        | Non-empty. Handed to the agent verbatim. ≤ 262144 bytes UTF-8                  |
| `agent`    | no       | string          | `cursor` | Must be a supported agent; `cursor` is the only one today                      |
| `model`    | no       | string          | _(none)_ | Absent means "use the harness's `--model`"                                     |
| `parallel` | no       | boolean         | `true`   | A real boolean — `parallel: "false"` is rejected                               |
| `tags`     | no       | list of strings | `[]`     | Only meaningful with `parallel: false`                                         |

The exact messages, worth knowing because they are what an author sees:

- `` `id` must look like TC-24, not "TC24" `` — the value is quoted back as JSON.
- `` `id` is TC-25 but the file is named tc-24 `` — the cross-check that catches a copy-paste.
- `` `name` must not be empty `` — distinct from `must be a string`, so a `name: "   "` is caught.
- `` `parallel` must be true or false ``.
- `` `agent` must be one of cursor, not "claude" ``.
- `` `tags` must be a list of strings `` and, per element, `` `tags[0]` must be a string ``.
- `` `tags` only constrains a case with `parallel: false`; remove one or the other ``.
- `` `plan` is 300000 bytes; the limit is 262144 ``.

Every problem in a file is reported together, and every broken file in a directory is reported before
any agent launches — so one `cairn qa run --dry-run` is the complete verdict on a `_plans/` tree.

## 3. Why `plan` is bounded

The plan travels to the agent as a single argv string. Unbounded, a runaway plan would fail at
`spawn` with a bare `E2BIG` and no indication of which case caused it. The 256 KiB ceiling exists to
turn that into a named, actionable error at load time.

It is not a target. Real plans run 15–65 KB, so the ceiling is roughly four times the largest
sensible plan. A plan approaching it is a plan that should have been split into two cases.

## 4. `name` is a title, not a heading

`name:` is the bare title — no `TC-N —` prefix, no `— test case plan` suffix. The plan body's H1
carries the decorated form, and `name:` carries what sits between the dashes:

```yaml
id: TC-30
name: A bare scenario forecast becomes adjustable
```

```markdown
# TC-30 — A bare scenario forecast becomes adjustable — test case plan
```

The tracker prints `name:` in its Title column and falls back to a `qa-testing.md` index beside the
runs directory when a case file cannot be read, so where both exist the two must agree.

## 5. Choosing a model

`model:` is per case because cases differ in what they need, and a queue run under one global model
either overpays for the cheap cases or underserves the hard ones.

- A case whose work is extraction, comparison and transcription — most CLI cases — wants a fast model.
- A case that has to _identify_ something ambiguous (which panel is which, which DOM node contains
  which), or reconcile a route difference between what the source document describes and what the
  surface actually offers, wants a reasoning model.
- Omit `model:` only when the case genuinely has no preference. The harness's `--model` then applies,
  and it will change under the case without the case changing.

Where the repository documents a default model — a `TC-HARNESS.md` profile at its root, or the
existing plans beside this one — read it rather than choosing from memory.

## 6. Choosing `parallel` and `tags`

The three states, and what each costs:

| Declaration                     | Meaning                            | Cost                                                       |
| ------------------------------- | ---------------------------------- | ---------------------------------------------------------- |
| `parallel: true`                | Runs whenever a slot is free       | None. The default, and right for most cases                |
| `parallel: false` + `tags: [x]` | At most one running case holds `x` | Serialises only against other `x` cases                    |
| `parallel: false`, no `tags`    | A barrier: runs entirely alone     | Drains the whole queue. Use only when nothing else will do |

**Tag what the case actually contends for, not the case.** A tag names a shared resource — a port, a
server instance, a database, a lock file, a generated artifact that a second run would overwrite. Two
cases share a tag when they would corrupt each other, and not otherwise. `tags: [tc-10]` is a tag per
case, which serialises nothing and reads as if it did.

A barrier is almost always the wrong reach. It stops the entire queue, including every case that had
no conflict with it. Prefer a tag naming the resource; reach for a barrier only when a case perturbs
something global — a shared build output, a machine-wide service — that no tag can circumscribe.

**A tagged case explains its tag in §0.** The frontmatter and the plan body are maintained by hand
and nothing cross-checks them, so a case that carries `tags: [kps-admin]` and says nothing about why
will lose the tag the next time someone edits it. The corpus does this consistently: the two browser
cases both carry `tags: [kps-admin]`, and both say in §0 that they own a specific port for the length
of the run, that they run non-parallel precisely so one instance exists at a time, and that finding
the port already in use is an UNVERIFIED rather than a reason to pick another port.

## 7. The block scalar

`plan:` is written as a literal block scalar so the markdown survives verbatim:

```yaml
plan: |
  # TC-30 — A bare scenario forecast becomes adjustable — test case plan

  You are running **one** test case: ...
```

Every line of the plan is indented two spaces; that indentation is stripped on load and is not part
of the plan. Two consequences for anyone generating these files:

- Write the file with a YAML library set to a literal block scalar and an unlimited line width. A
  serializer left on its default will fold long lines or fall back to a quoted scalar, and both
  change the plan text.
- **Verify the round trip before trusting the file**: parse what you just wrote and compare `plan`
  byte for byte against the text you meant to store. A plan that silently became a folded scalar
  still loads, still runs, and gives the agent a document with its line structure destroyed.

## 8. What the schema does not check

The harness validates the file and not the plan. Everything in `plan-standards.md` — the fourteen
sections, the quoted expectations, the artifact naming, the embedded record skeletons — is prose the
harness will accept in any shape at all. `cairn qa run --dry-run` is the complete verdict on the
file; nothing checks the prose but a reader.
