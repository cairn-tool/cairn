# Gemini CLI: archiving

Declared by the `gemini-cli` entry in `src/archive/sets.ts`. The log root comes from the usage
provider, so the archive covers `~/.gemini`.

## Artifact sets

| Set            | Class        | Matches                                     |
| -------------- | ------------ | ------------------------------------------- |
| `plans`        | `plan`       | `tmp/<slug>/<session uuid>/plans/*.md`      |
| `tool-outputs` | `artifact`   | `tmp/<slug>/tool-outputs/session-<uuid>/**` |
| `transcripts`  | `transcript` | `tmp/<slug>/chats/**/*.jsonl`               |
| `history`      | `log`        | `tmp/<slug>/logs.json`                      |

`plans` and `tool-outputs` are in the default run; `transcripts` and `history` are opt-in. On the
reference corpus the default run is 544 files and about 2 MB, while the transcripts alone are
436 MB.

## Everything is rooted at `tmp`

`~/.gemini` is a shared tree, and the confinement is what makes selecting from it safe:

- `antigravity-cli/` belongs to the [other provider](../antigravity/archiving.md) rooted here,
  and would otherwise be archived twice under two provider names.
- `antigravity/` is the IDE's own store, which is encrypted at rest.
- `oauth_creds.json` and `google_accounts.json` are credentials.

None of them is reachable from `tmp`.

## There is no catch-all under `tmp` either

The CLI downloads helper binaries into `tmp/bin/` — a 3.2 MB `rg` on the machine this was written
against — beside the projects. Every matcher requires a **named directory segment**, so nothing
that is not conversation data can match one. This is the same rule as Claude Code's exclusion of
`downloads/` and `jobs/`, arrived at from the same discovery: a blocklist over a shared directory
eventually fails to exclude something.

`history` is depth-checked rather than matched on its basename, so a `logs.json` written deeper
in a project cannot be swept in as project history.

`.project_root` is not archived. It is one line duplicating `projects.json` and is not
conversation data.

## Class placement

`plans` is Markdown under a `plans/` directory, and `tool-outputs` is everything under
`tool-outputs/` — the directory name is the whole distinction, exactly as `.system_generated` is
for Antigravity. Neither is told apart by a list of filenames, which would go stale.

There are no live databases here, so no set needs `snapshot: "sqlite"`.

## Related

- [Shared archive command behavior](../../commands/archive/common.md)
- [Usage logs](usage-logs.md) — the same root, read for a different purpose
