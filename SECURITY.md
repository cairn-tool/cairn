# Security policy

## Supported versions

Only the latest published version of `@cairn-tool/cairn` receives fixes. Releases are
automated, so the latest version is always the tip of `main` — there are no maintenance
branches.

| Version        | Supported |
| -------------- | --------- |
| Latest release | Yes       |
| Anything older | No        |

## Reporting a vulnerability

**Do not open a public issue.** Report privately through GitHub Security Advisories:

<https://github.com/cairn-tool/cairn/security/advisories/new>

Include the version (`cairn --version`), the platform, and the smallest input that
reproduces the problem. A proof of concept is welcome; a working exploit is not required.

You can expect an acknowledgement within a few days and an assessment within two weeks.
If a report is accepted, the fix ships in the next release and the advisory is published
with credit unless you ask otherwise.

## What is in scope

Cairn reads files, writes files, and — in exactly one command — executes them. Its
security-relevant boundaries are:

- **`scripts run`** is the only command that executes anything. The guards are the feature:
  resolution stops at the git root and refuses to run outside a repository, `node_modules`
  is skipped so a vendored `.cairn.yml` cannot win by being nearest, the resolved `cwd` is
  containment-checked as well as the registry file, and forwarded arguments are passed as
  separate argv entries so the shell never lexes them. A way around any of those is a
  vulnerability.
- **`md check-snippets --write`** copies file contents into tracked documents. Reads are
  confined to the configured workspace root by realpath containment, and writes to a
  narrower containment root. An escape from either is a vulnerability.
- **`agent install --register` and `agent marketplace --install --register`** write to host
  configuration outside the workspace. A registration that deletes or overwrites a key it
  did not write is a vulnerability.
- **`archive extract`** is the only command that writes outside its own store. A member
  that escapes the extraction root is a vulnerability.
- **Machine-readable output.** Nothing may write to a stream carrying a JSON, JSONL, or
  SARIF payload. A corrupted parse in a consumer is a bug worth reporting, though not
  usually a security one.

## What is out of scope

- The content of the files Cairn analyses. Cairn reports on Markdown and bundle sources;
  it does not sanitise them, and a document that makes a report look alarming is not a
  vulnerability.
- Findings that require an attacker to already control the repository being analysed _and_
  the machine running the command.
- Dependency advisories with no reachable call path from Cairn. Report them anyway if you
  are unsure — Dependabot covers the rest.
