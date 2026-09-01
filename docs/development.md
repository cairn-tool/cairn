# Development

Building and testing Cairn itself. Contribution conventions — commit messages, the pre-push
checklist, and the checklist for adding a subcommand — are in
[CONTRIBUTING.md](https://github.com/cairn-tool/cairn/blob/main/CONTRIBUTING.md).

```bash
git clone git@github.com:cairn-tool/cairn.git
cd cairn
npm ci

npm test           # builds dist/ via `pretest`, then runs unit/integration/e2e suites
npm run test:watch
npm run build      # tsc -> dist/
npm run lint       # ESLint
npm run format     # Prettier (write); `npm run format:check` in CI
npm run typecheck  # tsc --noEmit

npm link           # expose the working tree as the global `cairn`, see Install above
npm unlink -g @cairn-tool/cairn
```

The e2e suite spawns the **compiled** `dist/cli.js`, so a build must precede it — `pretest`
handles that automatically.

## The test suites

| Suite               | Runs against                                             |
| ------------------- | -------------------------------------------------------- |
| `tests/unit`        | The source modules directly.                             |
| `tests/integration` | Several modules together.                                |
| `tests/e2e`         | The **compiled** `dist/cli.js`, spawned as a subprocess. |

The e2e suite spawns the compiled CLI rather than the source, which is why `pretest` builds
first. Removing that script makes the e2e suite test whatever `dist/` happened to hold.

## Related

- [Releasing](releasing.md) — what happens after a merge to `main`.
- [Machine-readable result contract](contract.md) — what counts as a breaking change.
- [Cairn's own plugins](plugins.md) — building the bundles locally, and the per-host
  install scripts under `scripts/`.
