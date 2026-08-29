# `agent package`

## Synopsis

```text
cairn agent package <source> --target <target> --output <dir> [options]
```

Turns a bundle into a distributable package: the rendered payload plus marketplace catalogs,
checksums, a file inventory, and optional deterministic archives — with publish-readiness
checks over all of it.

Packaging is a separate stage from [`agent convert`](convert.md) so that `convert`
remains a pure compiler. **Actual publication, authentication, and submission are deliberately
out of scope.** This command never contacts the network. It produces a complete package and a
checklist; taking an irreversible external action is left to you.

**Stability: experimental.** The payload shape may change before it hardens.

## Arguments

| Argument | Required | Description  |
| -------- | -------- | ------------ |
| `source` | Yes      | Bundle root. |

## Options

| Option                 | Default  | Description                                                    |
| ---------------------- | -------- | -------------------------------------------------------------- |
| `--target <target>`    | Required | Repeatable target: `claude-code`, `codex`, `cursor`, or `all`. |
| `--output <dir>`       | Required | Package root. Must not be inside the bundle.                   |
| `--profile <profile>`  | `both`   | `plugin`, `project`, or `both`.                                |
| `--marketplace <mode>` | `repo`   | Catalog mode: `repo`, `local`, or `none`.                      |
| `--archive`            | Off      | Also emit a deterministic `.tar.gz` per target and profile.    |
| `--from-dist <dir>`    | None     | Verify an existing `agent convert` tree matches this bundle.   |
| `--strict`             | Off      | Treat warnings as blocking findings.                           |
| `--force`              | Off      | Replace nonempty selected destinations.                        |
| `--dry-run`            | Off      | Build in memory without writing.                               |
| `--check`              | Off      | Compare against an existing package without writing.           |
| `--format <fmt>`       | `llm`    | Output as `llm`, `human`, or `json`. Shorthands: `-fh`, `-fj`. |
| `--envelope`           | Off      | Wrap `--format json` output in the versioned result envelope.  |
| `-h`, `--help`         | —        | Show help.                                                     |

`--check` and `--dry-run` cannot be combined.

## It renders the bundle itself

`agent package` runs the renderer rather than reading an existing output tree, so the catalog
and the checksums are provably derived from the source of truth — a package can never certify a
tree that has drifted. `--from-dist` covers the other question, "did CI build what this bundle
produces?", by rendering in memory and comparing; a mismatch is `AB508` and nothing is written.

## Package layout

```text
<output>/
  <target>/<profile>/…                              payload, plus the catalog
  archives/<name>-<version>-<target>-<profile>.tar.gz   with --archive
  checksums.sha256
  sbom.json
  package-report.json
```

> The package root is **not** an `agent convert` output root. Do not point
> `agent doctor --output` at it — the catalog and integrity files are not conversion artifacts
> and would be reported as unmanaged.

## Catalogs are profile data

Which fields a catalog entry carries, which of them are required, where the catalog file goes,
and what assets the target expects all live in `src/agent/targets/*.ts` alongside the rest of
the target's behavior. The packager resolves fields from that table, so it contains no
per-target branching and updating a catalog format is a data edit. `agent specs --format json`
publishes the table.

A profile names two field lists. `documentFields` are the catalog's own identity, written at the
document's top level; `entryFields` describe one plugin inside it. Either list may declare a
`transform`, because targets disagree on the shape of the same bundle datum:

| Transform  | Effect                        | Used by                                          |
| ---------- | ----------------------------- | ------------------------------------------------ |
| `identity` | The value as parsed (default) | Claude Code `owner` and `author`, every `source` |
| `name`     | An object's `name`            | Cursor `author`, Codex `publisher`               |
| `first`    | A list's first element        | Claude Code `category`, which is singular        |

## Claude Code requires a marketplace owner

Claude Code refuses a catalog with no top-level `name` or `owner`, and enforces that the `name`
match the `extraKnownMarketplaces` key — which `agent install --register` derives from the bundle
name, so the two agree by construction. `owner` comes from `marketplace.publisher`, so a bundle
without one is `AB500` rather than a catalog Claude Code would silently drop on load.

A schema-1 bundle cannot declare a `marketplace` block at all (`AB127`), so packaging one for
`claude-code` means running `agent upgrade --to-schema 2` first.

## Deterministic archives

`--archive` writes ustar `.tar.gz` files built to be byte-identical across runs and machines:

- `mtime`, `uid`, and `gid` are zero; `uname` and `gname` are empty, so no build machine's user
  is embedded.
- Modes are normalized to `0644` or `0755`, so a stray `0o777` in a bundle cannot ship.
- Entries are sorted by **byte** comparison, not `localeCompare`, which is ICU- and
  locale-dependent and would reorder the archive on a differently configured runner.
- The gzip header's mtime is zeroed and its OS byte pinned to Unix.
- A path that will not fit a ustar header is refused (`AB509`) rather than escalated to a PAX
  record, which would carry its own name and mtime needing a separate determinism policy.

## Integrity files

`checksums.sha256` is GNU coreutils format, so `sha256sum -c checksums.sha256` works verbatim
from the package root.

`sbom.json` is a file inventory, and says so: `"bomFormat": "cairn-inventory"`. It is
**not** a CycloneDX document. Each component carries its path, a content-derived type
(`script`, `executable`, `binary`, `config`, `document`, `asset`), digest, size, mode, and
whether it came from the portable layer or a native overlay.

## Diagnostics

| Code    | Severity | Meaning                                                             |
| ------- | -------- | ------------------------------------------------------------------- |
| `AB500` | error    | A required catalog field is missing or empty.                       |
| `AB501` | error    | The catalog version disagrees with the bundle version.              |
| `AB502` | error    | A required marketplace asset is missing from the package.           |
| `AB503` | warning  | An asset has the wrong extension, is not an image, or is oversized. |
| `AB504` | warning  | An executable file sits outside `hooks/`, `scripts/`, or `bin/`.    |
| `AB505` | error    | Two paths collide on a case-insensitive filesystem.                 |
| `AB506` | notice   | An MCP server invokes an unpinned package.                          |
| `AB507` | warning  | The target has no catalog for the selected marketplace mode.        |
| `AB508` | error    | The `--from-dist` tree is not what this bundle produces.            |
| `AB509` | error    | A path does not fit a ustar header.                                 |

Approximate render diagnostics alone do **not** fail packaging — a Codex bundle inherently
carries them, and they say nothing about publish readiness. Only errors, and warnings under
`--strict`, fail.

## Examples

```bash
# Full package with archives.
cairn agent package ./bundle --target all --output ./dist --archive

# Release-CI gate: no writes, exit 2 on any finding or drift.
cairn agent package ./bundle --target codex --output ./dist --check --strict

# Verify the tree CI already converted.
cairn agent package ./bundle --target all --output ./dist --from-dist ./converted

# What is stopping this from shipping?
cairn agent package ./bundle --target codex --output ./dist --dry-run -fj \
  | jq '.diagnostics[] | select(.severity == "error")'
```

## Exit codes

| Code | Meaning                                         |
| ---- | ----------------------------------------------- |
| `0`  | Package written, or checks passed.              |
| `1`  | Invocation, path, or I/O error.                 |
| `2`  | Publish-readiness, integrity, or stale finding. |
