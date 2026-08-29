# Cursor: archiving

**There is no Cursor archive profile.** `ARCHIVE_PROFILES` in `src/archive/sets.ts` holds
`claude-code`, `codex`, and `antigravity`; `archive run` collects nothing from Cursor, and
`archive status` never reports a Cursor artifact.

## Why not

An archive profile names an existing usage provider — `ArchiveProfile.provider` matches a
`UsageProvider.name`, and that is what resolves the log root to walk. With no
[usage provider](usage-logs.md) there is no root, so there is nothing for a set to be relative
to.

The dependency runs one way only. It exists because both roles need the same answer to "where
does this host keep its files, and is it present on this machine", and answering it twice
would let the two drift.

## What registering one would take

A Cursor usage provider first, and then an `ArchiveProfile` entry declaring its sets: for each,
an id, an [artifact class](../../commands/archive/common.md), a root directory, whether the walk
recurses, a match predicate over the POSIX-relative path, and `snapshot: "sqlite"` for anything
that is a live database.

The selection rule that applies to every provider would apply here too: an **allowlist of
directories**, never a filter over a whole home directory. The reason is on the
[Claude Code archiving page](../claude-code/archiving.md#what-is-deliberately-excluded) — a
blocklist eventually fails to exclude something, and what it fails on tends to be large.

## Related

- [Shared archive command behavior](../../commands/archive/common.md)
- [Archive store format](../../formats/archive-store.md)
- [Usage logs](usage-logs.md) — the dependency this follows from
