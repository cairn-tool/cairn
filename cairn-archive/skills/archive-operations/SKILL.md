---
name: archive-operations
description: Archive assistant plans, artifacts, transcripts, and logs into long-term storage with the cairn archive toolset. Use when capturing what an assistant produced before it is pruned, checking what an archive already holds, or verifying an archive's integrity.
---

# Archiving with cairn

`cairn` must be on `PATH`. Every command takes `--format llm|human|json` (`-fh`/`-fj`) and exits
`0` clean, `1` on a usage error, `2` when it found something.

Longer conventions: [`${CLAUDE_PLUGIN_ROOT}/assets/cli-basics.md`](../../assets/cli-basics.md).

## What it archives, and why that matters

An assistant leaves plan documents, files its tools produced, session transcripts, and logs. Those
get pruned. The archive copies them somewhere durable, incrementally: unchanged files are never
reopened, and content already stored is never written twice.

Segments are ordinary `.tar.gz` files whose members are named by their own content hash, so `tar`
recovers them with no index and no `cairn` — the point of a store meant to outlive the tool that
wrote it.

## `archive run` writes, and can write a lot

```bash
cairn archive run --dry-run                            # always start here
cairn archive run                                      # plans and artifacts
cairn archive run --include plans,artifacts,transcripts
cairn archive run --provider all
cairn archive run --archive /Volumes/backup/cairn
```

| Option                   | Meaning                                                |
| ------------------------ | ------------------------------------------------------ |
| `--include <classes>`    | `plans`, `artifacts`, `transcripts`, `logs`            |
| `--provider <name>`      | One log source, or `all`; defaults to `claude-code`    |
| `--archive <dir>`        | Archive location; defaults under `XDG_DATA_HOME`       |
| `--dry-run`              | Report what would be archived without storing anything |
| `--segment-size <bytes>` | Seal a segment at this many uncompressed bytes         |
| `-v`, `--verbose`        | One durable line per artifact, with its disposition    |

**Run `--dry-run` first and tell the user the volume.** Adding `transcripts` can turn a
150 MB run into several gigabytes. This is a long, writing operation into a directory the user
chose — possibly external storage — so it should never be implicit.

`--archive` names a durable location the user picked. If they have one, use it consistently:
a second archive in a different directory shares no content with the first.

## Cursor is two trees, and its store holds credentials

Cursor is an editor rather than a CLI, so its data is split in two: the conversation store sits in
the Electron user-data directory, while its plans, agent transcripts, and produced files sit under
`~/.cursor`. It is the only provider needing a second root, and a set whose tree is absent
contributes nothing rather than falling back to the other one.

That store is class `log` and 5.65 GB on its own — larger than every other provider's entire
corpus put together — so a default run here takes the plans and the produced files, roughly 6 MB,
and leaves it alone.

> **`cairn archive run --include logs --provider cursor` archives live credentials.** `ItemTable`
> holds `cursorAuth/accessToken` and `cursorAuth/refreshToken`. Other providers' databases hold
> credentials incidentally; Cursor's is a known credential store. Say so before running it, and
> treat any archive containing that set as a secret.

## `archive status` and `archive list`

```bash
cairn archive status                       # what does it hold?
cairn archive list --class plan --top 40
cairn archive list --provider all --since 2026-01-01
```

`status` is the cheap orientation command — run it before `run` to see whether the work is
already done.

`list` takes `--class` (`plan`, `artifact`, `transcript`, `log`), `--provider`, `--since` as an
ISO day, and `--top <n>` with `0` for all.

## `archive verify`

```bash
cairn archive verify           # index against segments
cairn archive verify --deep    # decompress everything and re-hash every blob
```

**`verify` exits 2 without `--strict`, and that is deliberate.** Every other `usage` and `archive`
command treats an unreadable file as routine, because over thousands of artifacts a file removed
mid-walk is normal. Corruption is not routine — it is the finding this command exists to report,
so making it opt-in would defeat the point.

Treat an exit 2 here as a real problem, not as the usual "found something".

`--deep` is slow: it decompresses every segment. Use it when you actually suspect corruption or
before relying on the archive, not as a routine check.

## Retrieving

Getting a file back out, and the store's own format, are in the `archive-retrieve` skill.

## More

Full flags and the segment model are in [`reference/archive.md`](reference/archive.md).
