# Long-term archiving

What the `archive` toolset keeps, how it stores it, and how to get it back.

`usage` reports on transcripts; `archive` keeps what a session actually produced. Plan documents,
the files tools fetched or rendered, and — when asked for — the transcripts and logs themselves,
copied into append-only compressed segments with a SQLite index.

```bash
cairn archive run --dry-run                 # what would be taken, and how much
cairn archive run                           # plans and artifacts, every provider
cairn archive run --include transcripts,logs --archive /Volumes/Backup/cairn
cairn archive status
cairn archive list --class plan --top 50
cairn archive extract ~/.claude/plans/some-plan.md --out /tmp
cairn archive verify --deep
```

Three things make it worth pointing at storage you care about.

**A segment is an ordinary `.tar.gz`.** Members are named by their own SHA-256, so `tar tzf`
recovers the contents with no index and no `cairn` — the point of a standard container for a store
meant to outlive the tool that wrote it. Naming members by hash also means identical files are
stored once, and that every member name is short enough for the ustar header, which the real
paths (nested seven deep under project slugs) are not.

**Runs are incremental twice over.** A file whose size and modification time already match the
index is never opened; a file that is opened but whose content is already stored is never written
again. A second run over an unchanged corpus costs one `stat` per file. A file that _changes_ gets
a new row against a new blob, so the archive accumulates every version it ever saw and
`archive extract` can reach an older one by hash.

**What is archived is declared, not swept.** Each provider names the directories worth keeping, so
the 340 MB of plugin payloads and the 343 MB of build scratch under `~/.claude` are not excluded
by a blocklist that might one day miss something — they are simply never walked. Live SQLite
stores, which all carry `-wal` sidecars, are read through the online backup API so the archived
copy is a consistent snapshot rather than a possibly torn page image.

See [shared archive command behavior](../commands/archive/common.md) for the full set list,
storage layout, and exit codes, and [docs/formats/archive-store.md](../formats/archive-store.md)
for the on-disk format.

## Related

- [Shared archive command behavior](../commands/archive/common.md) — the set list and the storage layout.
- [Archive store](../formats/archive-store.md) — segments, the index, and its hand-owned version.
- [Deterministic tar](../formats/deterministic-tar.md) — why a segment is byte-reproducible.
