# Cairn plugins — cursor

Generated from [`cairn-tool/cairn`](https://github.com/cairn-tool/cairn) at
`31a871b5b961fd03ae705b05df1de64150d7191a`. Do not edit this branch: it is force-pushed on every release.

The catalog is `.cursor-plugin/marketplace.json`, at this branch's root.

Cursor has no CLI for adding a marketplace. In the dashboard, go to **Plugins ->
Team Marketplaces -> Add Marketplace -> Import from Repo** and point it at this
repository and the `cursor-plugins` branch; a team marketplace is a Teams or
Enterprise feature.

Without one, install from a checkout of the source repository instead:

```bash
cairn agent install plugins/<bundle> --target cursor --scope user
```

Every plugin wraps the `cairn` CLI, which is installed separately.
