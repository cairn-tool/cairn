# Contributing to Cairn

Cairn is a CLI meant to be run by agents and CI as much as by people, so most of its rules
exist to keep machine-readable output stable. This page covers the ones that will otherwise
bite you.

## Setup

```bash
git clone git@github.com:cairn-tool/cairn.git
cd cairn
npm ci
npm test        # builds dist/ via `pretest`, then runs the suites
```

Node must satisfy `engines` in `package.json` (currently `^22.22.2 || ^24.15.0 || >=26.0.0`).
`.nvmrc` names the version CI uses for everything except the test matrix.

## Before opening a pull request

```bash
npm run format:check && npm run lint && npm run typecheck && npm test
```

CI runs all four, plus the test suite across the full Node matrix, a plugin-bundle job, and a
commit-message check. A red matrix cannot publish — the Release workflow is gated on CI
succeeding, not on the push.

## Commit messages

[Conventional Commits](https://www.conventionalcommits.org/) are **required**. semantic-release
derives the version from them, and both a `commit-msg` hook and a CI job reject malformed
messages.

| Prefix                           | Effect        |
| -------------------------------- | ------------- |
| `fix:` / `perf:`                 | patch release |
| `feat:`                          | minor release |
| `feat!:` or `BREAKING CHANGE:`   | major release |
| `chore:` `docs:` `test:` `ci:` … | no release    |

Changes confined to `plugins/` use `chore(plugins):` or `docs(plugins):`. `feat(plugins):`
would mint a minor **CLI** release for a `SKILL.md` edit.

## Things that will surprise you

- **The e2e suite spawns the compiled CLI** (`dist/cli.js`), not the source. `npm test` builds
  first via `pretest`; do not remove that script.
- **ESM only.** Relative imports must carry the `.js` extension — `moduleResolution` is
  `NodeNext`.
- **Never hand-edit `version` in `package.json` or `CHANGELOG.md`.** semantic-release owns both.
- **`publishConfig` is load-bearing.** `access: "public"` is what lets a scoped package publish
  at all; `provenance: true` is what signs the tarball.
- **Every `--format json` payload goes through `jsonPayload`** in `src/result.ts`. Writing
  `JSON.stringify` inline at a new site silently opts that command out of `--envelope`.
- **Sort generated output by byte comparison, never `localeCompare`** — it is ICU-build and
  locale dependent, so a differently configured runner would reorder archives and manifests.
- **No published schema may set `additionalProperties: false` or `$ref` another document.**
  `tests/unit/contract-schemas.test.ts` enforces both.

`AGENTS.md` is the long form of this list, and is worth reading before a first substantial
change.

## Versions you should not bump

Six versions in this repository are owned by hand rather than by semantic-release, and none of
them is the package version. A normal change bumps none of them; see `docs/contract.md` for
what each one covers and when it legitimately moves.

## Adding a subcommand

The checklist is in `AGENTS.md`, and it is enforced: `tests/e2e/contract.test.ts` fails on any
command that is not declared in `src/contract/registry.ts`. In short — an action in
`src/commands/`, a registration in `src/cli.ts`, a registry entry, a docs page with links from
`docs/commands.md` and `docs/_contents.md`, a README entry, and e2e coverage.

## Reporting a vulnerability

Privately, through GitHub Security Advisories. See [SECURITY.md](SECURITY.md).
