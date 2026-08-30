# Installing Cairn

`cairn` is published as [`@cairn-tool/cairn`](https://www.npmjs.com/package/@cairn-tool/cairn) on
the public npm registry. The installed binary is named `cairn`.

## Install

No registry configuration and no token — the package is public.

```bash
npm install -g @cairn-tool/cairn   # global `cairn` binary
npx @cairn-tool/cairn md lint FILE # one-off, no install
```

Every published tarball is built by GitHub Actions and carries an [npm provenance
attestation](https://docs.npmjs.com/generating-provenance-statements) linking it to the
workflow run that produced it, so you can verify that what you installed came from this
repository. Releases publish through [trusted
publishing](https://docs.npmjs.com/trusted-publishers) — no long-lived registry credential
exists to be stolen.

## Provenance

Every release is published through OIDC trusted publishing, which attests the build
automatically. `npm view @cairn-tool/cairn` reports the provenance, and
`npm audit signatures` verifies it.

## Keeping a stable path across Node upgrades

`npm install -g` places the binary inside the active Node install. Under a version manager
such as nvm that directory changes on every Node upgrade, which silently breaks anything
holding an absolute path to the CLI (Claude Code hooks, for example). Pin a stable path:

```bash
mkdir -p ~/.local/bin
ln -sf "$(npm root -g)/@cairn-tool/cairn/dist/cli.js" ~/.local/bin/cairn
```

Make sure `~/.local/bin` is on your `PATH`.

## Installing from source with `npm link`

Skip the registry entirely and link a local clone to run a specific commit instead of the
latest published release:

```bash
git clone git@github.com:cairn-tool/cairn.git
cd cairn
npm ci
npm run build   # tsc -> dist/cli.js
npm link        # symlinks the global `cairn` binary to this working tree
```

`npm link` points the global `cairn` binary at `dist/cli.js` in this working tree
instead of copying files, so pulling new commits only requires `npm run build` again — no
need to re-run `npm link`. Remove the link with:

```bash
npm unlink -g @cairn-tool/cairn
```

## Uninstalling

```bash
npm uninstall -g @cairn-tool/cairn
```

Nothing is left behind outside the package except the update-check cache at
`${XDG_CACHE_HOME:-~/.cache}/cairn/`, and the usage and archive stores if you created them.

## Related

- [Migrating from claude-cli](migration.md) — if you had the pre-rename package.
- [Update checks](update-checks.md) — what the CLI checks for, and how to turn it off.
- [`completion`](commands/completion.md) — shell completion for bash, zsh, fish, and PowerShell.
- [Development](development.md) — building from source.
