# Gemini CLI

Google's Gemini CLI. Like Antigravity, it is a usage log source and an archive source and not a
conversion target — and it shares a home directory with Antigravity, which is the first thing to
know about it.

| Role              | Supported | Identifier   | Declared in                         |
| ----------------- | --------- | ------------ | ----------------------------------- |
| Conversion target | **no**    | —            | no target profile exists            |
| Usage log source  | yes       | `gemini-cli` | `src/usage/providers/gemini-cli.ts` |
| Archive source    | yes       | `gemini-cli` | `src/archive/sets.ts`               |

It is the most distorted token log of the four registered sources, in the specific sense that it
is the only one whose figures need **three** separate corrections before they mean anything. Each
of the other providers needs one.

## Where things live

`~/.gemini`. There is no environment override — the CLI was checked for one and none is honoured
for the data root — so `--logs <dir>` is the only way to point it elsewhere.

```text
~/.gemini/
  tmp/<slug>/.project_root                            the absolute project root, as text
  tmp/<slug>/logs.json                                typed prompts and slash commands
  tmp/<slug>/chats/session-<stamp>-<short>.jsonl      main transcript
  tmp/<slug>/chats/<parent session uuid>/<id>.jsonl   subagent transcript
  tmp/<slug>/<session uuid>/plans/*.md                plan documents
  tmp/<slug>/tool-outputs/session-<uuid>/*.txt        captured tool output
  tmp/bin/                                            downloaded helper binaries
  projects.json                                       project root -> slug, duplicating .project_root
```

## It shares `~/.gemini` with Antigravity

Both CLIs are Google's and both keep their state under `~/.gemini`, but they share nothing else.
Antigravity's provider roots at `~/.gemini/antigravity-cli` and guards on `conversations/`;
this one roots at `~/.gemini` and guards on `tmp/`. Neither can claim the other's tree, and
`--provider all` reports them separately.

Every archive set here is rooted at `tmp` for the same reason, which also puts `antigravity/`
— the IDE's store, encrypted at rest — and `oauth_creds.json` out of reach.

## Subagents dominate

On the corpus this provider was written against there are 63 main transcripts and 1,714 subagent
transcripts, and the subagents carry more than half again as many token records as the main
threads do. A figure taken with `--no-subagents` is a main-thread figure, not a total.

Gemini CLI is one of the two providers that records subagent-ness in the transcript's **path**,
so it is one of the two that can drop them before opening anything.

## Pages

- [Agent bundles](agent-bundles.md) — why there is no conversion target
- [Usage logs](usage-logs.md) — the transcript format and how it is counted
- [Archiving](archiving.md) — the artifact sets `archive run` collects

## Caveats worth knowing up front

- A slash command's **name** survives only in `logs.json`. The transcript keeps the expanded
  prompt, so `/deploy prod` reaches the chat as `prod`.
- A subagent transcript records no role of its own. The role is in the parent's `invoke_agent`
  call, so `usage agents --by role` gets its names from the parent side.
- One transcript in a real corpus has no header line at all, so the header is detected rather
  than assumed.
