# Package format

What [`agent package`](../commands/agent/package.md) produces: a rendered tree plus the
artifacts that make it distributable — marketplace catalogs, checksums, a file inventory, and
optional byte-reproducible archives, with publish-readiness checks over all of it.

`agent package` **renders the bundle itself** rather than trusting an existing tree, so a
package can never certify a stale one. It never contacts the network and never publishes.

## Layout

```text
<output>/
  claude-code/{plugin,project}/
    .claude-plugin/marketplace.json        # catalog, per target and mode
    …                                      # the rendered tree
  codex/{plugin,project}/
  cursor/{plugin,project}/
  archives/<name>-<version>-<target>-<profile>.tar.gz   # with --archive
  checksums.sha256
  sbom.json
  package-report.json
```

## Marketplace catalogs

One catalog per target, at the location and with the shape that target's profile declares.
Distribution mode is `repo` or `local` (or `none` to skip catalogs entirely); a target whose
profile declares no `marketplace` spec is skipped rather than given an invented catalog.

All three shipped targets write `<target>-plugin/marketplace.json` with `plugins` as the
entries key, but they disagree substantially about the fields — including about the _shape of
the same datum_. `marketplace.publisher` lands as an object for Claude Code, a bare name string
for Codex, and an optional bare name for Cursor; `marketplace.categories` lands as a singular
`category` for Claude Code and as the whole list for the other two.

That disagreement is declared per target rather than special-cased in the packager. See the
marketplace section of each provider's page:
[Claude Code](../providers/claude-code/agent-bundles.md#marketplace-catalog),
[Codex](../providers/codex/agent-bundles.md#marketplace-catalog),
[Cursor](../providers/cursor/agent-bundles.md#marketplace-catalog).

A required catalog field with no source value in the bundle's `marketplace:` block is a
packaging error, which is why a bundle that packages cleanly for one target may legitimately
fail for another.

## `checksums.sha256`

`sha256sum -c` compatible, so it needs no special tooling:

```text
<64 hex digits>  <path>
```

Two spaces between the digest and the path, one line per artifact, terminated by a newline.
Lines are sorted by **byte comparison of the path** — never `localeCompare` — so the file is
reproducible on any runner.

It covers every artifact including the archives, but not itself, `sbom.json`, or
`package-report.json`.

## `sbom.json`

A file inventory, and **deliberately not a CycloneDX claim**. `bomFormat` and `specVersion`
identify it as this tool's own format, so a later `--sbom cyclonedx` can be added without
changing what this one means.

```jsonc
{
  "bomFormat": "cairn-inventory",
  "specVersion": "1",
  "generator": { "name": "@cairn-tool/cairn", "version": "1.12.0" },
  "subject": { "name": "release-helper", "version": "1.0.0" },
  "components": [
    {
      "path": "claude-code/plugin/hooks/guard.sh",
      "type": "script",
      "sha256": "…",
      "bytes": 48,
      "mode": "0755",
      "origin": "portable",
    },
  ],
}
```

`origin` is written explicitly here as `"portable"` or `"native"` — unlike
`conversion-report.json`, where it is emitted only when native.

### `type` is content-derived

Classification is by content and mode, not by extension alone, and the rule is exported because
`agent audit --baseline` reads the `type` field back and must classify the current side the
same way:

| Type         | Rule                                                     |
| ------------ | -------------------------------------------------------- |
| `script`     | any execute bit set **and** the content starts with `#!` |
| `executable` | any execute bit set, without a shebang                   |
| `binary`     | not executable, but contains a NUL byte                  |
| `config`     | extension `.json`, `.yaml`, `.yml`, or `.toml`           |
| `document`   | extension `.md`                                          |
| `asset`      | everything else                                          |

The order matters: executability is checked first, so an executable `.md` is a `script`, not a
`document`.

## `archives/`

With `--archive`, one deterministic `.tar.gz` per target and profile. The name comes from the
target profile's `archiveName` template, which is
`{name}-{version}-{target}-{profile}.tar.gz` for all three shipped targets.

Each archive contains that `<target>/<profile>/` subtree with the prefix stripped, so it
unpacks as the plugin root rather than four levels down.

The archives are byte-reproducible: mtime, uid, gid, uname, gname, mode, and entry order are
all pinned. See [Deterministic tar](deterministic-tar.md).

A path that will not fit a ustar header is an `AB509` error rather than an escalation to a PAX
record.

## `package-report.json`

```jsonc
{
  "catalogs": [
    {
      "target": "claude-code",
      "profile": "plugin",
      "path": "claude-code/plugin/.claude-plugin/marketplace.json",
    },
  ],
  "archives": [
    {
      "target": "claude-code",
      "profile": "plugin",
      "path": "archives/release-helper-1.0.0-claude-code-plugin.tar.gz",
      "sha256": "…",
      "bytes": 20480,
    },
  ],
  "checksums": "checksums.sha256",
  "sbom": "sbom.json",
  "checks": { "passed": 14, "failed": 0 },
}
```

`checks.failed` counts diagnostics of severity `error`; `checks.passed` counts everything else.

## Publish-readiness checks

| Code    | Checks                                                                        |
| ------- | ----------------------------------------------------------------------------- |
| `AB500` | a catalog field the target requires has no source value in the bundle         |
| `AB501` | the catalog version disagrees with the bundle version                         |
| `AB502` | a required marketplace asset is missing, or is not in the package             |
| `AB503` | an asset has the wrong extension, does not look like an image, or is oversize |
| `AB504` | an executable file outside `hooks/`, `scripts/`, or `bin/`                    |
| `AB505` | a case-insensitive path collision                                             |
| `AB506` | an MCP server invoked through an **unpinned** `npx` specifier                 |
| `AB507` | the target declares no catalog for the selected distribution mode             |
| `AB508` | `--from-dist` tree is not what this bundle produces                           |
| `AB509` | a path that cannot be expressed in a ustar header                             |

The unpinned-dependency check looks at `mcpServers.*` entries whose `command` is `npx`, takes
the first non-flag argument, and flags it when it carries no `@version` suffix — a bare package
name resolves to whatever is newest at install time.

`AB504`, `AB505`, and `AB506` are **re-emitted by `agent audit` rather than given new IDs**.
One condition keeps one ID whichever command surfaces it, or a consumer's suppression list
breaks.

## Related

- [`agent package`](../commands/agent/package.md), [`agent audit`](../commands/agent/audit.md)
- [Deterministic tar](deterministic-tar.md)
- [Audit baselines](audit-baseline.md) — `sbom.json` read back as a baseline
- [Conversion output](conversion-output.md) — the tree `agent package` renders first
