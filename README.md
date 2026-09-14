# cairn — release 1.2.0

**Generated branch. Do not edit.** The source lives on `main`; this tree is built by CI and
pushed here. See https://github.com/cairn-tool/cairn.

| Plugin | Hosts | Description |
| ------ | ----- | ----------- |
| `cairn-markdown` | claude-code, codex, cursor, antigravity | Validate, analyze, and refactor Markdown with the cairn md toolset. |
| `cairn-scripts` | claude-code, codex, cursor, antigravity | Resolve and run named scripts declared in .cairn.yml. |
| `cairn-usage` | claude-code, codex, cursor, antigravity | Report on LLM assistant usage from local session logs. |
| `cairn-archive` | claude-code, codex, cursor, antigravity | Archive assistant plans, artifacts, and transcripts into long-term storage. |
| `cairn-agent` | claude-code, codex, cursor, antigravity | Author, convert, migrate, test, and publish portable agent bundles. |
| `cairn-jira` | claude-code, codex, cursor, antigravity | Convert Jira and Confluence rich text between ADF and Markdown. |
| `cairn-pdf` | claude-code, codex, cursor, antigravity | Read PDF documents — text, structure, and conversion to Markdown. |
| `cairn-qa` | claude-code, codex, cursor, antigravity | Author and run TC-N test-case plans with the cairn qa toolset. |

## Claude Code

```text
/plugin marketplace add git@github.com:cairn-tool/cairn.git#release
/plugin install cairn-markdown@cairn
```

## Codex

`--ref` is what pins the marketplace to this branch; without it Codex fetches the
repository's default branch, which carries the bundle sources and no catalog at its root.

```bash
codex plugin marketplace add cairn-tool/cairn --ref release
codex plugin add cairn-markdown@cairn
```

Codex installs from a local snapshot of this catalog, so a later release reaches an existing
install only through `codex plugin marketplace upgrade cairn`.

## Cursor

```bash
agent plugin marketplace add git@github.com:cairn-tool/cairn.git --git-ref release
```

## Antigravity

This host declares no marketplace catalog, so the published source
bundles are the install route. `cairn agent install` takes a bundle root and renders it in
memory, so nothing else is needed:

```bash
git clone --branch release git@github.com:cairn-tool/cairn.git
cairn agent install cairn/bundles/cairn-markdown --target antigravity --scope user
```

## Pinning

To pin an exact release, use the tag rather than the branch: `#release-v1.2.0` for Claude Code,
`--git-ref release-v1.2.0` for Cursor, `--ref release-v1.2.0` for Codex. Pinning also opts out of
background auto-update.

Prefer the SSH URL where one is shown. Claude Code's background refresh disables git
credential helpers for its `git pull`, so HTTPS auto-update against a private repository can
fail silently; a key loaded in `ssh-agent` authenticates background pulls the same as
foreground ones.
