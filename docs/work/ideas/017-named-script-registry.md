# 017. Named Script Registry and the `scripts` Toolset

| Priority | Effort | Status  |
| -------- | ------ | ------- |
| P1       | Medium | Shipped |

**Payoff:** Make hook and skill scripts resolve from any working directory.

Delivered as [`scripts run`](../../commands/scripts-run.md),
[`scripts which`](../../commands/scripts-which.md), and
[`scripts list`](../../commands/scripts-list.md). The proposal below is the original text; where
the implementation diverged, the command pages are authoritative. The material corrections:

- **`run:` uses `/bin/sh`, not the user's shell**, with a per-script `shell:` key for bashisms.
  `fish` and `csh` do not bind positional parameters for `-c`, so honoring `$SHELL` would make a
  committed registry behave differently per machine.
- **A script's resolved `cwd` is containment-checked too**, not just the registry file. `cwd`
  decides where the script's own relative paths land, which makes it the more attractive escape.
- **Registries under `node_modules` are skipped.** Nearest-definition-wins is the feature; a
  vendored package shipping a `.cairn.yml` is where it would otherwise become a
  supply-chain hole, which the trust-boundary section below does not acknowledge.
- **Outside a Git repository, `scripts run` refuses** unless `--root` is given; `which` and
  `list` still report. The proposal left the no-repository case unspecified, and it is where the
  boundary rule would otherwise disappear.
- **A script that never started exits `1`, not `2`.** The proposal's two `--format json`
  outcomes miss the third, which would make a typo in `exec[0]` indistinguishable from a
  legitimately failing test suite.
- **A `run:` body that ignores its positional parameters while arguments were supplied is an
  error**, rather than silently dropping them.
- **The exit-code divergence is declared, not just noted**, through a new optional
  `exitCodePassthrough` field on `CommandContract` — the `describe` schema publishes
  `enum: [0,1,2]` for `exitCodes`, which the proposal does not mention.
- The depth counter is a footgun guard, not a security control; it is script-clearable and does
  not belong in the trust-boundary list below.

Not done: the repository does not dogfood its own `scripts:` block. Any `.cairn.yml` here
sets `config.root` to the repository, which confines the workspace and breaks the contract
suite's temporary-workspace cases. Insulating that suite is a prerequisite.

## Problem

A hook or a skill that injects generated content references a script by a repository-relative
path. That path is resolved against the process working directory, and an agent's working
directory moves as it works. The moment the agent is operating inside `packages/web/`, the
hook's `./.claude/scripts/gather-context.sh` no longer exists and the hook fails. Absolute
paths avoid the failure but are not portable across machines or checkouts, and the script's
_own_ relative paths break the same way even when the interpreter finds it.

The missing piece is a stable name that resolves to a script from anywhere in the tree, and an
execution that pins the working directory to the project rather than inheriting the caller's.

## Concept

A `scripts:` section in `.cairn.yml`, and a `scripts` toolset that resolves a name by
walking the directory tree upward from the invocation directory.

```yaml
version: 1
scripts:
  gather-context:
    description: Collect repository context for the planning skill
    run: ./.claude/scripts/gather-context.sh
  lint-changed:
    description: Lint only the files changed against the default branch
    exec: ["npm", "run", "lint"]
    cwd: registry
```

**Command sketch:**

```text
cairn scripts run gather-context -- --since main
cairn scripts which gather-context
cairn scripts list
```

## Resolution

Resolution is a **chain** walk, not the first-hit walk `findConfig` performs. `findConfig`
returns the nearest `.cairn.yml` and stops; a nested configuration that exists but does
not define `gather-context` must not shadow the root definition. So every `.cairn.yml`
from the invocation directory up to the boundary is read, and the nearest file that defines
the requested _name_ wins. Nearest-definition-wins also yields per-package overrides without
any additional mechanism.

The walk stops at the git root, or at `--root` when given, whichever is found first. It never
ascends past that boundary: without a stop condition a `scripts:` block in a home directory or
a temporary directory would silently capture a name.

## Execution

Two mutually exclusive forms per script:

- `run:` — a string executed through the user's shell. This is the ergonomic default and
  matches what hook definitions already contain.
- `exec:` — an argv array executed with no shell. Preferred where no shell features are
  needed, and the only form that is safe with interpolated arguments.

The working directory defaults to the directory of the registry file that defined the script,
which is what fixes the second half of the problem. `cwd:` accepts `registry` (default),
`invocation`, or a path relative to the registry. Arguments after `--` are appended for
`exec:` and exposed as positional parameters for `run:`. The child receives
`CAIRN_SCRIPT_NAME`, `CAIRN_SCRIPT_ROOT` (the registry directory), and
`CAIRN_INVOKED_FROM` (the original working directory), so a script that genuinely needs
the caller's location can still get it.

## Trust boundary

This is the first command in the tool that executes anything. The repository has been
deliberate about the opposite: `md check-snippets` never runs a snippet, and the idea index
lists arbitrary execution among the things to avoid. The distinction that makes this
acceptable is that the executed command is declared by name in a tracked file inside the
workspace, not discovered in content being analyzed — this is a resolver, not an evaluator.
The guards follow from that:

- The winning registry must resolve inside the containment root; a definition found above the
  boundary is refused rather than used.
- The registry path is realpathed, matching the containment rule `readSnippetSource` applies to
  snippet sources.
- A depth counter in the environment fails a script that re-enters `scripts run` beyond a small
  limit, so a self-referential definition errors instead of forking without bound.
- `scripts run` is never exposed by the read-only MCP server. `scripts which` and
  `scripts list` are ordinary read-only commands and may be.

## Contract

`scripts which` and `scripts list` are conventional read-only commands and need no special
handling. `scripts run` diverges in two places, and the divergence is recorded in the contract
registry `notes` the way `md links -fj` and `md lint-dir --summary` already are:

- **Exit codes.** In `llm` and `human` formats the child's streams pass through untouched and
  the child's exit status becomes the process exit status, because a hook needs the real code.
  That is outside the `0`/`1`/`2` contract and outside `CommandExit`'s type, so the action sets
  `process.exitCode` directly rather than terminating.
- **`--format json`.** A streamed child cannot also be a JSON payload, so this format captures
  stdout and stderr into a payload carrying the resolved script, the registry that defined it,
  the working directory, and the child's code and signal. The process then exits `0` when the
  script ran and `2` when it failed, keeping the envelope's `exitCode` within its declared
  type.

The update notice is suppressed for `scripts run`, for the same reason `completion` suppresses
it: a hook capturing the child's stderr must not receive the tool's own chatter.

---

[Back to the idea index](_contents.md)
