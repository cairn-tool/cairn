# Script resolution in full

See [`cli-basics.md`](../../../assets/cli-basics.md) for formats and config discovery.

## Shared options

Every `scripts` command takes:

| Option            | Meaning                                             |
| ----------------- | --------------------------------------------------- |
| `--root <dir>`    | Stop the upward walk at this directory              |
| `--config <file>` | Use one specific registry and skip the walk         |
| `--no-config`     | Disable discovery; every name then fails to resolve |

`scripts` commands accept **no** `commands:` defaults from `.cairn.yml`. A checked-in config may
declare what a script _is_, but must never change how it is invoked.

## `scripts run <name> [-- args...]`

| Exit | Meaning                                                           |
| ---- | ----------------------------------------------------------------- |
| —    | In `llm`/`human`, the **script's own** exit status passes through |
| `1`  | Invocation error, or the name did not resolve                     |

With `--format json` the streams are captured into the payload and the status is reported there.

## `scripts which <name>`

Reports the winning `.cairn.yml`, the working directory the script would run in, and any
same-named definitions it shadows. Executes nothing.

| Exit | Meaning                |
| ---- | ---------------------- |
| `0`  | The name resolved      |
| `1`  | Invocation error       |
| `2`  | No script by that name |

## `scripts list`

Every script visible from the working directory. Nearest definition wins, so a name declared in a
nested registry hides the one above it. Files that could not be parsed are **reported rather than
skipped silently**.

| Exit | Meaning                                       |
| ---- | --------------------------------------------- |
| `0`  | Listing written                               |
| `1`  | Invocation error                              |
| `2`  | A consulted configuration file was unreadable |

## The resolution walk

Every `.cairn.yml` from the working directory up to the boundary is consulted, and the nearest
file that **defines the requested name** wins. A nested file that exists but does not declare the
name does not shadow an ancestor that does — so per-package overrides work without a nested
registry redeclaring everything above it.

Discovery is **per-directory-then-ascend**, not per-name-then-ascend: `.cairn.yml` then the
pre-rename `.claude-cli.yml` are tried in one directory before moving up. Walking each name over
the whole chain instead would let a legacy file in the repository root beat a nested `.cairn.yml`.

### The boundary

The walk stops at the repository root, or at `--root` when it is deeper.

**Outside a Git repository there is no boundary**, so `scripts run` refuses unless `--root` sets
one. Without that rule the walk would fall back to the nearest configuration file, which in a
scratch directory can mean a world-writable one in a shared parent. `which` and `list` still
report there, because reporting is not executing.

### `node_modules` is skipped

Nearest-wins is the feature; a vendored package shipping its own `.cairn.yml` is where that would
otherwise become a supply-chain hole.

### Unreadable files

A file **nearer** than the winner that cannot be read is an error rather than a skip — it might
have defined the name, and running the wrong script is the failure this design exists to prevent.
A malformed file **farther** than the winner cannot change the answer and is reported without
failing.

## The guards, concretely

- The winning registry must resolve inside the boundary, through symlinks.
- It must be a regular file under 1 MiB with no NUL bytes.
- A script's resolved working directory must also stay inside the boundary, since `cwd` decides
  where the script's own relative paths land.
- Forwarded arguments reach `sh -c` as separate `argv` entries, never interpolated into the body.
