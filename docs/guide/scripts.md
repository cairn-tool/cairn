# Named scripts

Why the `scripts` toolset exists, and the guarantees that make running a named command acceptable.

A hook or a skill that references a script by a repository-relative path breaks the moment the
calling process changes directory — and absolute paths are not portable across checkouts. The
`scripts` toolset resolves a script by **name** instead, and runs it with its working directory
pinned to the project.

```yaml
# .cairn.yml
version: 1
scripts:
  gather-context:
    description: Collect repository context for the planning skill
    run: ./.claude/scripts/gather-context.sh "$@"
  lint-changed:
    exec: ["npm", "run", "lint"]
```

```bash
cairn scripts run gather-context          # same result from any directory
cairn scripts run lint-changed -- --fix   # arguments after -- are forwarded
cairn scripts which gather-context        # which registry wins, without running it
cairn scripts list                        # every name visible from here
```

Every `.cairn.yml` from the working directory up to the repository root is consulted, and
the nearest file that **defines the requested name** wins — so a nested package can override one
script without redeclaring the rest. Files under `node_modules` are skipped.

In `llm` and `human` formats the script's streams pass through untouched and its exit status
becomes the process's exit status, so a hook reads the real code; `--format json` captures the
streams into a payload instead. Running outside a Git repository is refused unless `--root` sets
the boundary explicitly.

This is the only command that executes anything. What makes that acceptable is that the command
is declared by name in a tracked file inside the workspace rather than discovered in content
being analyzed — the registry sits at the same trust level as a `Makefile`. See
[`scripts run`](../commands/scripts/run.md) for the full boundary.

## Related

- [`scripts run`](../commands/scripts/run.md) — the full boundary and every flag.
- [`scripts which`](../commands/scripts/which.md) — which registry wins, without running anything.
- [`scripts list`](../commands/scripts/list.md) — every name visible from here.
- [Project configuration](../configuration.md#script-registry) — the `scripts:` block.
