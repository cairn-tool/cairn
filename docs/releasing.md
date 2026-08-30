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

## What semantic-release does not own

Five versions are hand-owned and are **not** touched by a release. Bumping one is a deliberate
act, described in [the contract](contract.md):

| Version                    | Versions what                                      |
| -------------------------- | -------------------------------------------------- |
| `CONTRACT_VERSION`         | The machine-readable result contract.              |
| `PROFILE_SCHEMA_VERSION`   | The shape of a target conformance profile.         |
| Bundle `schemaVersion`     | The source format an author writes.                |
| Test-file `schemaVersion`  | The contract-test assertion format.                |
| Usage store `user_version` | The SQLite schema, migrated rather than discarded. |

Each plugin bundle's `version:` is hand-owned too, and independent of the CLI's — see
[Cairn's own plugins](plugins.md).

## Related

- [Machine-readable result contract](contract.md) — the versioning rules.
- [Development](development.md) — running the checks a release is gated on.
- [Cairn's own plugins](plugins.md) — how the plugin branch is published.
