# Cairn plugins — codex

Generated from [`cairn-tool/cairn`](https://github.com/cairn-tool/cairn) at
`31a871b5b961fd03ae705b05df1de64150d7191a`. Do not edit this branch: it is force-pushed on every release.

The catalog is `.agents/plugins/marketplace.json`, at this branch's root.

`--ref` is what pins the marketplace to this branch; without it Codex fetches
the repository's default branch, which carries the bundle sources and no catalog
at its root.

```bash
codex plugin marketplace add cairn-tool/cairn --ref codex-plugins
codex plugin add <plugin>@cairn
```

Codex installs from a local snapshot of this catalog, so a later release reaches
an existing install only through `codex plugin marketplace upgrade cairn`.

Every plugin wraps the `cairn` CLI, which is installed separately.
