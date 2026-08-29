# File formats and schemas

Cairn reads, writes, and version-controls a number of formats. This directory documents the
ones **Cairn itself owns** — the files it defines, the versions it hand-maintains, and the
guarantees each carries. Formats owned by somebody else are documented per host under
[Providers](providers.md).

## The formats

| Format                                                  | File                                                                       | Versioned by                                 | Owner                           |
| ------------------------------------------------------- | -------------------------------------------------------------------------- | -------------------------------------------- | ------------------------------- |
| [Agent bundle](formats/agent-bundle.md)                 | `agent-bundle.yaml`                                                        | `schemaVersion` (hand-owned)                 | authors                         |
| [Bundle contract tests](formats/agent-tests.md)         | `tests/**/*.test.yaml`                                                     | `schemaVersion` (hand-owned)                 | authors                         |
| [Target profile](formats/target-profile.md)             | `src/agent/targets/*.ts`                                                   | `PROFILE_SCHEMA_VERSION`                     | this project                    |
| [Conversion output](formats/conversion-output.md)       | `conversion-report.json`, `import-report.json`                             | payload schema major                         | `agent convert`, `agent import` |
| [Package](formats/package.md)                           | `checksums.sha256`, `sbom.json`, `marketplace.json`, `package-report.json` | `specVersion` on the inventory               | `agent package`                 |
| [Install manifest](formats/install-manifest.md)         | `.cairn-install.json`                                                      | unversioned; shape-checked                   | `agent install`                 |
| [Usage store](formats/usage-store.md)                   | `usage.db`                                                                 | `PRAGMA user_version` (hand-owned, migrated) | `usage`                         |
| [Archive store](formats/archive-store.md)               | `archive.db`, `segments/*.tar.gz`                                          | `PRAGMA user_version` (hand-owned, migrated) | `archive`                       |
| [Deterministic tar](formats/deterministic-tar.md)       | `*.tar.gz`                                                                 | none — byte-stable by construction           | `agent package`, `archive`      |
| [Markdown conventions](formats/markdown-conventions.md) | TOC markers, snippet links                                                 | none — both spellings read                   | `md`                            |
| [Audit baselines](formats/audit-baseline.md)            | baseline JSON, `sbom.json` as baseline                                     | `version` / `bomFormat`                      | `md audit`, `agent audit`       |
| [Diagnostics](formats/diagnostics.md)                   | `AB###` codes, `Issue`, SARIF                                              | SARIF 2.1.0                                  | every checker                   |

Two more formats are documented elsewhere because they have their own pages:

- **Project configuration** — `.cairn.yml`, including the script registry:
  [Project configuration schema](configuration.md)
- **Command result payloads** — the JSON every command emits, the `--envelope` wrapper, and the
  published JSON Schemas: [Machine-readable result contract](contract.md)

## Hand-owned versions

Five versions in this project are owned by hand rather than by semantic-release, and **none of
them is the package version**. They version different things and move independently. A normal
release bumps none of them.

| Version                        | Versions                                               | Reported by                                    |
| ------------------------------ | ------------------------------------------------------ | ---------------------------------------------- |
| Contract `schemaVersion`       | The contract surface                                   | `describe`, the `--envelope` wrapper           |
| Target profile `schemaVersion` | The structure of a target conformance profile          | `agent specs`                                  |
| Bundle `schemaVersion`         | The `agent-bundle.yaml` format authors write           | `agent inspect`                                |
| Test file `schemaVersion`      | The assertion format `agent test` cases are written in | `agent test`                                   |
| Usage store version            | The SQLite schema of `usage.db`                        | `usage index`, `usage migrate`, `usage import` |

The full rules — what a bump means, and why the usage store is the odd one out — are in
[the contract document](contract.md#the-other-hand-owned-versions).

## Two kinds of on-disk state

The distinction decides how a version mismatch is handled, and it is worth naming.

**Caches** are disposable. A version mismatch throws the file away, costs a re-parse, and can
never produce a wrong answer. Their versions are private, undocumented, and safe to bump at
will:

| Cache             | Location                                      |
| ----------------- | --------------------------------------------- |
| URL check results | `$XDG_CACHE_HOME/cairn/url-checks.json`       |
| Workspace index   | `$XDG_CACHE_HOME/cairn/workspaces/<key>.json` |
| Update check      | `$XDG_CACHE_HOME/cairn/update-check.json`     |

**Data** cannot work that way. Once `archive run --include transcripts` has run and the source
logs are pruned, these files may hold the only surviving copy of what they describe, so a
version bump has to carry the data forward:

| Store       | Location                        |
| ----------- | ------------------------------- |
| Usage store | `$XDG_DATA_HOME/cairn/usage.db` |
| Archive     | `$XDG_DATA_HOME/cairn/archive/` |

`$XDG_DATA_HOME` defaults to `~/.local/share` and `$XDG_CACHE_HOME` to `~/.cache`. The archive
root is also relocatable with `--archive`, which is the expected shape once transcripts are
included.

## Rules that apply to every format here

**Sorting is by byte comparison, never `localeCompare`.** It is ICU-build and locale dependent,
so a differently configured CI runner would reorder archives, manifests, checksums, and
baselines. One historical exception remains in `src/agent/render.ts` for a value that is
already observable; it is not to be copied.

**A separator inside a composite key is a NUL.** It cannot occur in either half, and a space
can and does occur in a path. This applies to the usage store's session keys, the archive's
artifact keys, and the audit baseline's finding identity.

**Generated output is byte-stable.** Given the same input, the same version produces the same
bytes: archives pin mtime, uid, gid, uname, and entry order; JSON documents are built in a
fixed key order because `JSON.stringify` follows insertion order.

**No published JSON Schema sets `additionalProperties: false`, and none `$ref`s another
document.** The first would make every additive change break validating consumers; the second
would make `cairn schema <id>` return something that cannot be compiled on its own.
`tests/unit/contract-schemas.test.ts` enforces both.

**Every pre-rename spelling is still read.** The tool was `claude-cli` through v1.11.0. Cairn
**writes** the new spelling and **reads** either, for the config file, the TOC markers, the
snippet attribute, the install manifest, the two baseline discriminators, and the environment
variables. `tests/unit/legacy-names.test.ts` is the contract for that.
