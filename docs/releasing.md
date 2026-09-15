# Releasing

Releases are fully automated. Every push to `main` runs
[semantic-release](https://github.com/semantic-release/semantic-release), which derives the
next version from the commit messages, tags it, writes `CHANGELOG.md`, creates a GitHub
Release, and publishes to npm. Nothing is versioned by hand — `version` in `package.json` is
managed by the release job.

Publishing uses OIDC trusted publishing rather than a stored npm token, which is also what
generates the provenance attestation. The trusted publisher is registered against the
`release.yml` workflow filename, so renaming that file breaks publishing.

Commits **must** follow [Conventional Commits](https://www.conventionalcommits.org/); a
`commit-msg` hook and a CI job both enforce it.

| Commit prefix                    | Effect        |
| -------------------------------- | ------------- |
| `fix:` / `perf:`                 | patch release |
| `feat:`                          | minor release |
| `feat!:` or `BREAKING CHANGE:`   | major release |
| `chore:` `docs:` `test:` `ci:` … | no release    |

> **The `conventionalcommits` preset in `.releaserc.json` is what makes the `!` row true.**
> semantic-release defaults to the `angular` preset, whose header pattern does not allow a `!` at
> all — so `feat!: …` does not parse as a `feat`, and a breaking change with no `BREAKING CHANGE:`
> footer is analyzed as **no release at all**. Not a smaller release: none. The commit merges, the
> job reports success, and nothing ships.
>
> `conventional-changelog-conventionalcommits` is a declared devDependency for the same reason.
> It resolves transitively through `@commitlint/config-conventional` today, and an `npm ci` after
> that tree changes would take the preset with it.
>
> **It is pinned to `^9`, and that is load-bearing.** Preset 10 requires
> `conventional-changelog-writer@9`; `@semantic-release/release-notes-generator@14.1.1` — the
> newest there is — depends on `^8.0.0`. With preset 10 the commit analysis succeeds and then
> `generateNotes` dies on `Missing helper`, so the release fails _after_ deciding the version.
> Commitlint keeps its own copy of 10 nested; only the root copy reaches semantic-release. Do not
> bump this to 10 until release-notes-generator ships a writer-9 dependency.

## What semantic-release does not own

Five versions are hand-owned and are **not** touched by a release. Bumping one is a deliberate
act, described in [the contract](contract.md):

| Version                          | Versions what                                      |
| -------------------------------- | -------------------------------------------------- |
| `CONTRACT_VERSION`               | The machine-readable result contract.              |
| `PROFILE_SCHEMA_VERSION`         | The shape of a target conformance profile.         |
| Bundle `schemaVersion`           | The source format an author writes.                |
| Test-file `schemaVersion`        | The contract-test assertion format.                |
| Usage store `user_version`       | The SQLite schema, migrated rather than discarded. |
| Release manifest `schemaVersion` | The document a release branch carries.             |

Each plugin bundle's `version:` is hand-owned too, and independent of the CLI's — see
[Cairn's own plugins](plugins.md).

## Related

- [Machine-readable result contract](contract.md) — the versioning rules.
- [Development](development.md) — running the checks a release is gated on.
- [Cairn's own plugins](plugins.md) — how the `release` branch is published.
- [Release manifest](formats/release-manifest.md) — what that branch carries.
