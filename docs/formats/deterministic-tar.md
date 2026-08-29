# Deterministic tar

Both [`agent package`](package.md) archives and [archive](archive-store.md) segments use the
same writer, `src/agent/package/tar.ts`. Given the same entries it produces the same bytes, on
any machine, on any run.

That matters for two different reasons. A package archive is a **distributable** whose hash
someone may compare against a rebuild. A segment is **content-addressed storage** whose
integrity check is the hash of the file itself.

## Format

Plain **ustar**, gzipped. No PAX records, no GNU extensions.

## What is pinned

Every field that could otherwise vary between machines or runs:

| Field                  | Value                                                                                   |
| ---------------------- | --------------------------------------------------------------------------------------- |
| `mtime`                | `0`                                                                                     |
| `uid`, `gid`           | `0`                                                                                     |
| `uname`, `gname`       | empty — a nonempty `uname` would embed the building machine's user in the archive bytes |
| `devmajor`, `devminor` | `0`                                                                                     |
| `mode`                 | normalized; see below                                                                   |
| entry order            | byte comparison of path, never `localeCompare`                                          |
| gzip `MTIME`           | overwritten with `0`                                                                    |
| gzip `OS` byte         | overwritten with `0x03` (Unix)                                                          |

Node already writes a zero gzip mtime, but the OS byte is a compile-time zlib constant that
differs across platforms. Normalizing it keeps the archive byte-identical on macOS, Linux, and
Windows.

Sorting is by byte comparison because `localeCompare` is ICU-build and locale dependent, and
would otherwise reorder the archive on a differently configured CI runner.

## Mode normalization

A file mode collapses to one of two values:

| Input               | Stored |
| ------------------- | ------ |
| any execute bit set | `0755` |
| no execute bit set  | `0644` |
| directory           | `0755` |

This drops group and other write bits and setuid, so a stray `0o777` in a bundle cannot ship
inside an archive.

## Directory entries

Directory entries are emitted explicitly, for every prefix of every file path, so `tar tf`
lists a complete tree. They are merged into the same byte-sorted order as the files.

## Padding

Blocks are 512 bytes. Each entry is a header block plus its content padded to a block boundary.
The archive ends with two zero blocks, and the whole thing is padded to a 20-block record —
GNU's default blocking factor, which keeps every tar implementation happy.

## Long paths

The ustar `name` field holds 100 bytes and `prefix` holds 155. A path longer than 100 bytes is
split across the two at a `/` boundary, choosing the first split where both halves fit.

**A path that will not fit either way is refused**, as `TarPathTooLongError`, rather than
escalated to a PAX header. PAX records carry their own name and mtime, which would need a
separate determinism policy; refusing is honest and can be relaxed later.

`agent package` surfaces this as `AB509`. The archive store never hits it, because its members
are named by content hash and are always exactly 73 characters — see
[Archive store format](archive-store.md#members-are-named-by-content-hash).

## Reading

`src/archive/tar-read.ts` reads back exactly what this writer emits: regular files,
directories, and the `prefix` split. A PAX or GNU long-name header is reported as a
`TarFormatError` rather than guessed at.

It reports each member's path, mode, size, and the byte **offset of its data** within the
uncompressed archive — which is what lets the archive store slice a single blob out of a
64 MiB segment without walking it.

## Related

- [Package format](package.md)
- [Archive store format](archive-store.md)
