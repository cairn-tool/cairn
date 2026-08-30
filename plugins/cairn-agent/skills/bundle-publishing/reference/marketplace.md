# Packaging, install, and marketplace in full

See [`cli-basics.md`](../../../assets/cli-basics.md) for formats and exit codes.

## `agent package <source>`

| Option                  | Default  | Meaning                                        |
| ----------------------- | -------- | ---------------------------------------------- |
| `--target <target>`     | Required | Repeatable, or `all`                           |
| `--output <dir>`        | Required | Package root; must not be inside the bundle    |
| `--profile <profile>`   | `both`   | `plugin`, `project`, or `both`                 |
| `--marketplace <mode>`  | `repo`   | `repo`, `local`, or `none`                     |
| `--archive`             | off      | Deterministic `.tar.gz` per target and profile |
| `--from-dist <dir>`     | —        | Verify an existing convert tree matches        |
| `--strict`              | off      | Treat warnings as blocking                     |
| `--check` / `--dry-run` | off      | Compare, or build in memory                    |

```text
<output>/
  <target>/<profile>/…            payload, plus a one-entry catalog
  archives/<name>-<version>-<target>-<profile>.tar.gz
  checksums.sha256
  sbom.json
  package-report.json
```

`checksums.sha256` is GNU coreutils format, so `sha256sum -c checksums.sha256` works verbatim.
`sbom.json` is a file inventory and says so — `"bomFormat": "cairn-inventory"`. It is **not** a
CycloneDX document.

## `agent marketplace <spec>`

| Option                                         | Default                     | Meaning                                |
| ---------------------------------------------- | --------------------------- | -------------------------------------- |
| `--output <dir>`                               | Required unless `--install` | Collection root                        |
| `--target <target>`                            | The spec                    | **Narrows** the spec; may not add      |
| `--marketplace <mode>`                         | `repo`                      | `repo` or `local`                      |
| `--archive`                                    | off                         | One `.tar.gz` per plugin               |
| `--install`                                    | off                         | Install into the host marketplace root |
| `--scope` / `--into` / `--link` / `--register` | —                           | `--install` only                       |

```text
<output>/<target>/
  .claude-plugin/marketplace.json   the aggregated catalog, N entries
  <plugin>/                          one payload per bundle
```

Entry `source` is `./<plugin>`, relative to the catalog. No per-plugin `marketplace.json`.

### The spec

| Field           | Required | Rules                                                  |
| --------------- | -------- | ------------------------------------------------------ |
| `schemaVersion` | yes      | `"1"`                                                  |
| `name`          | yes      | kebab-case; also the host marketplace key              |
| `version`       | yes      | semver; the collection's own                           |
| `description`   | no       | catalog description                                    |
| `owner`         | yes      | `{ name, url?, email? }`                               |
| `targets`       | yes      | known target ids, or `[all]`                           |
| `bundles`       | yes      | `{ path, include?, exclude? }`; both lists is an error |

Bundle paths resolve from the spec's directory and may not escape it, including through symlinks.

Only `claude-code`, `codex`, and `cursor` declare a catalog. A selected target with none reports
`AB507`.

## Catalog fields per target

| Target        | Catalog path                      | Required entry fields                                            |
| ------------- | --------------------------------- | ---------------------------------------------------------------- |
| `claude-code` | `.claude-plugin/marketplace.json` | `name`, `version`, `description`, `source`                       |
| `codex`       | `.codex-plugin/marketplace.json`  | plus `displayName`, `publisher`, `categories`, `icon`, `license` |
| `cursor`      | `.cursor-plugin/marketplace.json` | plus `displayName`                                               |

Claude Code additionally requires a document-level `owner`. Its `author` is an **object**;
Cursor's is a bare name. Its `category` is **singular**, the first of the bundle's `categories`.

Codex **requires** an icon (`.png`/`.svg`, ≤ 1 MiB). Screenshots are `.png`/`.jpg`, ≤ 4 MiB.

## `agent install <source>`

| Target        | Scope   | Root                                    | Layout        | Activation                |
| ------------- | ------- | --------------------------------------- | ------------- | ------------------------- |
| `claude-code` | user    | `~/.claude/plugins/marketplaces/<name>` | `marketplace` | `~/.claude/settings.json` |
| `claude-code` | project | the working tree                        | `merge`       | none                      |
| `cursor`      | user    | `~/.cursor/plugins/local/<name>`        | `plugin-dir`  | none                      |
| `cursor`      | project | the working tree                        | `merge`       | none                      |
| `antigravity` | user    | `~/.gemini/config/plugins/<name>`       | `plugin-dir`  | none                      |
| `codex`       | user    | —                                       | —             | `AB800`                   |
| `opencode`    | user    | —                                       | —             | `AB800`                   |

`--into` replaces the **root**, not the final directory: a plugin-dir or marketplace install still
lands at `<into>/<name>`.

Each destination gets a `.cairn-install.json` recording generator, the installed unit's identity,
target, profile, scope, layout, mode, and a path/mode/sha256 inventory. `agent uninstall` removes
exactly that inventory; `agent installed` lists what it finds.

## Diagnostics

| Code            | Meaning                                                      |
| --------------- | ------------------------------------------------------------ |
| `AB500`         | A required catalog field is missing or empty                 |
| `AB501`         | The catalog version disagrees with the bundle version        |
| `AB502`         | A required marketplace asset is missing                      |
| `AB504`         | An executable sits outside `hooks/`, `scripts/`, or `bin/`   |
| `AB506`         | An MCP server invokes an unpinned package                    |
| `AB507`         | The target has no catalog for the selected mode              |
| `AB508`         | The `--from-dist` tree is not what this bundle produces      |
| `AB800`         | No recorded install location for this target and scope       |
| `AB801`         | Destination occupied by something else                       |
| `AB805`         | Host activation edit required but `--register` was not given |
| `AB807`         | `--link` in use; edits are live                              |
| `AB900`–`AB907` | Collection spec: schema, fields, bundle paths, selection     |
