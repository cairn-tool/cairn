---
name: archive-retrieve
description: Find and extract a file from a cairn archive. Use when recovering an archived plan, artifact, transcript, or log, or when applying pending archive index migrations.
---

# Getting things back out of a cairn archive

`cairn` must be on `PATH`. Every command takes `--format llm|human|json` (`-fh`/`-fj`).

Longer conventions: [`${BUNDLE_ROOT}/assets/cli-basics.md`](../../assets/cli-basics.md).

## Find, then extract

```bash
cairn archive list --class plan --since 2026-01-01     # find it
cairn archive extract <target> --out ./recovered       # write it back out
```

`archive extract` is the only archive command that writes **outside** the archive. Say where the
file will land before running it, and prefer an explicit `--out` over the default (the current
directory).

Narrow with `list` first. `--provider`, `--class`, `--since`, and `--top` all filter, and `-fj`
makes the result easy to pick from:

```bash
cairn archive list --class artifact -fj | jq -r '.artifacts[] | .path'
```

## You do not need cairn to read an archive

Segments are ordinary `.tar.gz` files. Members are named `blobs/<aa>/<sha256>` — the content's
own hash, which is both how deduplication works and a defence against the real paths being too
long for a ustar header.

If `cairn` is unavailable, `tar -tzf <segment>.tar.gz` lists a segment and `tar -xzf` extracts
it. You lose the mapping from original path to blob, which is what the index holds, but the
content is recoverable. That is the property the format exists for.

## Migrations

```bash
cairn archive migrate --check    # what is pending?
cairn archive migrate            # apply it
```

The archive index carries its own hand-owned version. An index from a **newer** build is refused
rather than opened, because it may carry columns this build would drop on its next write. If you
see that, the fix is upgrading `cairn`, not deleting the index.

Never delete an archive index to resolve a version complaint. After `archive run --include
transcripts` has run and the source logs were later pruned, the archive can be the only record of
that material left.
