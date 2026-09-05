# Cairn

A TypeScript/Node ESM CLI published as `@cairn-tool/cairn`. The binary is `cairn`.
Renamed from `claude-cli`; see the compatibility gotcha below.

## Layout

```
src/cli.ts             commander entry point; every subcommand is registered here
src/commands/*.ts      one file per subcommand, each exporting a `<name>Action`
src/checkers/*.ts      katex, mermaid, references, markdown-lint
src/markdown-ast.ts    shared unified/remark parsing + extraction helpers
src/snippets.ts        source-linked snippet parsing, extraction, and write planning
src/formatters.ts      llm / human / json output rendering
src/result.ts          the single `--format json` write path, and `--envelope`
src/agent/targets/*.ts versioned per-target capability profiles
src/agent/test/*.ts    bundle contract-test parsing, assertion evaluation, and digests
src/contract/*.ts      published JSON Schemas + the per-command contract registry
src/scripts/*.ts       named-script registry parsing, chain resolution, and execution
src/usage/*.ts         transcript parsing, day-bucketed aggregates, scan orchestration
src/usage/db/*.ts      the SQLite usage store: schema, migrations, import, queries
src/sqlite.ts          the node:sqlite loader, shared by every store
src/sqlite-store.ts    generic open + migrate for the two owned SQLite stores
src/archive/*.ts       artifact sets, tar reading, segments, and the archive index
src/usage/providers/*.ts  per-LLM log-source profiles
src/jira/adf/*.ts      ADF content model, both converters, and the AD diagnostic family
src/pdf/*.ts           the pdfjs boundary, layout inference, and the AP diagnostic family
src/mapping-quality.ts quality-to-severity, shared by the AB, AD, and AP families
src/config-schema.ts   validators shared by the config loader and the script registry
tests/{unit,integration,e2e}
```

There are seven toolsets, `md`, `agent`, `scripts`, `usage`, `archive`, `jira`, and `pdf`, plus the top-level
`check-update`, `describe`, and `schema`. Adding a subcommand means: a `src/commands/<name>.ts` exporting an action, a
`command(...)` registration in `src/cli.ts` whose action loads the module with `await import()`, a
`src/contract/registry.ts` entry, a
`docs/commands/<toolset>/<name>.md` page (top-level commands stay directly under
`docs/commands/`) with entries in `docs/commands.md` and `docs/_contents.md`, a row in
`docs/formats/diagnostic-codes.md` for any new `AB###`, `AD###`, or `AP###`, and e2e coverage. The README is a
README: it links into `docs/` and does not list commands. For an `agent` subcommand, also widen
`AgentResult["command"]` in `src/agent/types.ts` and the `command` enum plus `commands` list
in `src/contract/schemas/agent.ts`. A new toolset group also needs adding to **both** `groups` sets
in `tests/e2e/contract.test.ts`, which otherwise reports the group itself as `undeclared`. A
nested group such as `jira adf` is two entries, not one: the walk emits a node per level.

## Conventions

- ESM only (`"type": "module"`). Relative imports **must** carry the `.js` extension —
  `moduleResolution` is `NodeNext`.
- Output format is always selectable via `--format llm|human|json` (default `llm`), with
  `-fh`/`-fj` shorthands expanded in `src/cli.ts` before commander parses argv.
- Exit codes: `0` success, `1` usage error, `2` actionable issues found.
- `md rename-heading`, `md rename-file`, `md toc --write`, `md fix --write`,
  `md check-snippets --write`, `agent convert`, and `jira adf to-markdown`/`jira adf from-markdown`
  with `--output` are the commands that write to files.
- Every `--format json` payload goes through `jsonPayload` in `src/result.ts`, which is what
  makes `--envelope` reach all of them. Writing `JSON.stringify` inline at a new site silently
  opts that command out.

## Gotchas

- **`src/cli.ts` must never statically import a command module.** Every `./commands/*.js` is
  reached through `await import()` inside its `.action()` handler, so an invocation loads
  commander and the config/runtime prelude rather than all 52 command modules. A static
  `import { xAction } from "./commands/…"` drags that command's whole subgraph — markdownlint,
  pdf.js, the agent renderer — into every invocation of every other command, which took startup
  from ~100ms to 260ms. `import type` is erased and stays allowed; the option interfaces
  handlers annotate with are imported that way. `collect`, `TARGETS`, `formatsFor`, and the
  config/runtime/version/notifier imports are registration-time and stay static —
  **`collect` especially**, because `src/contract/describe.ts` compares `option.parseArg` against
  it by identity. `tests/unit/cli-imports.test.ts` enforces all of this against the source, and
  `tests/e2e/startup.test.ts` enforces it against a real process: it runs the CLI under a
  `module.register()` resolve hook (`tests/helpers/import-log-*.mjs`) and asserts `--help` loads
  **no** command module and a command loads exactly one. Assert on which modules resolved, never
  on elapsed time — the ratio against a bare `node -e ''` is 4.0x locally and 7.1-7.4x on a CI
  runner, because `node -e ''` is dominated by fixed V8 init while cairn's startup is dominated
  by reading and compiling several MB of JavaScript.
- **Every action handler must `return` what it calls.** `parseAsync` is awaited at the bottom of
  `src/cli.ts`, and the `CommandExit` → `process.exitCode` mapping and
  `runtime().workspace.flush()` both run after it. A handler that drops the `return` resolves
  early: the exit code is silently lost, the workspace index is not flushed, and a later
  `CommandExit` escapes as an unhandled rejection.
- **The e2e suite spawns the compiled CLI** (`dist/cli.js`), not the source. `npm test`
  builds first via `pretest`; do not remove that script.
- **`.markdownlintrc` must stay in `package.json` "files".** `src/checkers/markdown-lint.ts`
  resolves it as `dist/checkers/../../.markdownlintrc` and falls back to `{}` silently when
  it is absent, so dropping it degrades `--style` without any error. `tests/e2e/packaging.test.ts`
  guards this.
- **Never hand-edit `version` in `package.json` or `CHANGELOG.md`.** semantic-release owns
  both. `src/cli.ts` reads the version at runtime rather than inlining it.
- **The update notifier must never write to a machine-readable stream.** Both stdout and
  stderr carry payloads depending on the command (`--format json` puts JSON on stderr for
  `md lint`, stdout when clean), so `src/update-notifier.ts` refuses to print unless
  stderr is a TTY, the format is not JSON, `CI` is unset, and the opt-out variable is
  unset. Changing those gates risks corrupting a consumer's parse.
- **The notice prints from cache in a `process.on("exit")` handler.** Command actions signal
  exit status without terminating the process, while the network refresh happens in a detached child
  (`__refresh-update-cache`) guarded by an atomic `wx` lock file, so concurrent
  invocations spawn at most one.
- **`engines` mirrors jsdom, and the CI matrix must stay inside it.** jsdom is the
  most constrained dependency (`^22.22.2 || ^24.15.0 || >=26.0.0`); commander, katex
  and markdownlint all require `>=22`. v1.0.2 shipped claiming `>=20` and crashed on
  Node 20 with `webidl.util.markAsUncloneable is not a function`. When bumping any of
  these, re-check `npm view <pkg> engines` and update both `engines` and the matrix.
- **Release is gated on the CI workflow, not on push.** `release.yml` triggers via
  `workflow_run` after CI succeeds, so a red matrix cannot publish. It deliberately
  does not re-run the tests.
- **`publishConfig` is load-bearing, and both keys are.** The package publishes to the public
  registry.npmjs.org as `@cairn-tool/cairn`. `access: "public"` is required because npm
  defaults a _scoped_ package to restricted, and a restricted publish fails outright.
  `provenance: true` is redundant under trusted publishing, which attests automatically, but
  it keeps a token-authenticated publish attested too — so it stays. `GITHUB_TOKEN` covers
  only the tag, the Release, and the CHANGELOG commit; the registry is a separate identity.
- **Publishing is OIDC trusted publishing, and `npm install -g npm@12` in `release.yml` is
  what makes it work.** Trusted publishing needs npm >= 11.5.1 and Node >= 22.14.0. `.nvmrc`
  satisfies the Node floor, but Node 22 _bundles npm 10.9.7_, and the failure mode is nasty:
  `@semantic-release/npm`'s `verify-auth.js` performs the OIDC exchange purely as a check and
  **throws the returned token away**, leaving `npm publish` to exchange again on its own. An
  npm that predates the feature therefore passes verification and then fails at the publish,
  after the tag exists. Removing that upgrade step looks like tidying and is not.
- **`plugins.yml`'s trigger guard must not test `workflow_run.event`.** It is the third link in
  a `workflow_run` chain (CI -> Release -> Plugins), so the run that triggers it is Release,
  whose own event is `workflow_run` and never `push`. `release.yml`'s guard _does_ test for
  `push`, correctly, because the run triggering it is CI-on-push. Copying that clause into
  `plugins.yml` made the job skip on every release while reporting success.
- **A failed `npm publish` strands the release, and re-running the job does nothing.**
  semantic-release runs every plugin's `prepare` before any plugin's `publish`, and
  `@semantic-release/git`'s prepare is what pushes the version commit _and the tag_. So a
  publish failure leaves `main` advanced, the tag created, and npm empty — and the next run
  reads that tag as the last release, finds zero commits since, and reports "no new release".
  Recovery is to undo the git side, not to retry: delete the remote tag, force-push `main`
  back to the commit before the release commit, fix the cause, then re-run. Reordering
  `.releaserc.json` cannot avoid this; the phase boundary is semantic-release's, not ours.
- **The npm credential must bypass 2FA, which means granular or classic-Automation.** A
  classic _Publish_ token fails with `EOTP - This operation requires a one-time password`
  after the tarball has already been packed — i.e. late, in the publish step, with the git
  side already committed. This is the most likely way to hit the stranded-release case above.
- **The release job pushes as a GitHub App, not as `github-actions[bot]`.** The `main` ruleset
  requires four CI checks, and semantic-release's own CHANGELOG-and-version commit cannot
  satisfy them — it is created after CI ran. A ruleset bypass can only name an org-installed
  App, and GitHub Actions is not one, so `release.yml` mints an installation token with
  `actions/create-github-app-token` and hands _that_ to semantic-release as `GITHUB_TOKEN`.
  The job's own `permissions` are therefore `contents: read` plus `id-token: write` — widening
  them back to `contents: write` would not help, because the identity is what the ruleset
  checks, not the scope. `RELEASE_APP_ID` and `RELEASE_APP_PRIVATE_KEY` are the only two
  long-lived secrets, and the token they mint expires in an hour.
- **`NPM_TOKEN` is a bootstrap, not the auth path.** npm configures a trusted publisher on an
  existing package's settings page, so the first ever publish of a name has nowhere to
  configure it and needs a token. `verify-auth.js` tries OIDC first and only falls back to a
  token, so both can coexist: publish once with the secret, register the trusted publisher
  against the `release.yml` filename, then delete the secret. The workflow filename is part
  of that registration — renaming `release.yml` breaks publishing.
- **`ci.yml` must stay on `pull_request`, never `pull_request_target`.** It checks out and
  executes the PR's own code; the current trigger gives a fork a read-only token and no
  secrets. The other trigger would hand a fork's code a writable token and this repository's
  secrets. There is a comment on the trigger saying so.
- **Actions are pinned to commit SHAs with a trailing version comment.** Dependabot tracks
  `github-actions` weekly and preserves the comment when it bumps a pin. Replacing a SHA with
  a floating tag is a supply-chain regression, not a simplification.
- **ESLint uses the non-type-checked preset on purpose.** `tsc --strict` (`npm run typecheck`)
  is the type authority. typescript-eslint's `recommendedTypeChecked` flags ~26 long-standing
  intentional patterns here — uniformly-`async` commander handlers, `as unknown as` casts
  around jsdom globals, and `any` at the `JSON.parse`/YAML boundary. Adopting it means
  fixing those first, not just flipping the preset.
- **Target behavior is data, and the renderer reads that data.** `src/agent/targets/*.ts` holds
  the hook events, path roots and document names, manifest directories, model and tool maps,
  rule activations, the command-policy form, the skill invocation form, and the declared output
  patterns; `src/agent/render.ts` looks them up rather than branching on the target. Do not
  reintroduce an `if (target === …)` for anything tabular — the conformance fixtures assert that
  every emitted path is one the profile declares, so an undeclared hardcoded path fails the
  build. **Two branches remain on purpose**: Codex renders an agent as TOML and Cursor inlines a
  skill into its agents. Both are document shapes with no second target to generalize against.
  Everything that was tabular and still branched has been moved into the profile, and the two
  that mattered were load-bearing bugs — `renderPolicies` fell through to
  `.codex/rules/bundle.rules` for any target that was neither Claude Code nor Cursor, and the
  project MCP writer hardcoded `.mcp.json`. Both emitted a path the target's own profile did not
  declare.
- **Every visible command needs a `src/contract/registry.ts` entry.** `describe` merges the
  registry into the walked command tree, and `tests/e2e/contract.test.ts` fails on any command
  reported as `stability: "undeclared"` and on any registry id that no longer maps to a command.
  The registry records current behavior, including the known inconsistencies (`md links -fj`
  never exiting 2, `md lint-dir --summary`'s divergent shape) — those are documented in
  `notes`, not quietly fixed, because changing them is breaking.
- **Schemas and target profiles are TypeScript modules, not data directories.** `tsconfig` sets
  `rootDir: "src"` with no `resolveJsonModule`, so a top-level `schemas/` or `.json` profile
  would never reach `dist` and the published package would silently lack it — the same trap as
  `.markdownlintrc`, but with no error at all. Moving them means adding the directory to
  `package.json` `files` **and** to `tests/e2e/packaging.test.ts`.
- **`CONTRACT_VERSION` and `PROFILE_SCHEMA_VERSION` are hand-owned.** They version the contract
  surface and the target-profile structure, not the package. Do not bump them for a normal
  release; semantic-release does not touch them. Payload-level breaking changes are versioned by
  the major in the schema `$id` path instead. The rules are in `docs/contract.md`.
- **The bundle `schemaVersion` is a third hand-owned version.** It versions the _source_ format
  authors write (`src/agent/manifest.ts`), separate from `CONTRACT_VERSION` and
  `PROFILE_SCHEMA_VERSION`. Schema 2 is a strict superset of 1: it adds `marketplace:` and
  `native:` and changes nothing else, which is why `agent upgrade` can verify byte-identical
  rendering before and after and refuse (AB224) if that ever stops holding.
- **Antigravity and Codex both write project skills to `.agents/skills`, and that makes some
  imported trees genuinely ambiguous.** `distinctivePatterns()` derives its signals from the
  profile matrix, so a pattern two cells declare stops deciding anything. A project tree holding
  only `.agents/skills/<name>/` therefore scores equally for both and `agent import` throws
  naming the candidates, which is the designed behavior — it never guesses silently. A tree with
  rules or MCP alongside is unambiguous, because `.agents/rules/{name}.md` and
  `.agents/mcp_config.json` are Antigravity's alone.

- **A plugin manifest may sit at the plugin root, and the hook document may sit outside the hook
  script root.** Antigravity is the first target doing either: `manifest.directory` is `null` and
  `paths.plugin.hooksFile` is `hooks.json` beside `hooks/`. Both required import fixes rather
  than profile data alone — `detect.ts` required a manifest _directory_ before it would treat a
  layout as a plugin, which is the one signal that settles a plugin layout outright, and
  `normalizeHooks` only looked for the document _under_ the script root, so the document went
  unclaimed, the bundle ended up with no hooks, and the scripts were then dropped too because
  nothing emits them. `normalize.ts` also has to unwrap the `named` hook envelope, whose top
  level is the bundle name rather than an event.

- **Native overlay paths are deliberately undeclared.** `TargetProfile.outputs` describes what
  the _renderer_ emits; an overlay is user-supplied content whose whole purpose is a surface the
  portable profile does not describe. `agent doctor` and the conformance suite skip artifacts
  with `origin === "native"` and report them under `doctor.overlays`. Do not "fix" this by adding
  a `**` output pattern — that would disable the check for portable output too.
- **`Artifact.origin` is emitted only when `"native"`.** Always emitting it would change
  `conversion-report.json` and `agent convert -fj` bytes for every bundle that has no overlay.
- **`hasFindings` fails on any `approximate` diagnostic.** That is right for `convert` and
  `validate` and wrong for `doctor`, `import`, `upgrade`, `package`, `audit`, and `test`, where
  approximation is the expected outcome rather than a defect. Those call `outputDecidedResult`
  with their own error/strict rule. A new command that reports approximations should do the same.
- **`agent audit`'s exit rule is split by origin, not just by severity.** Almost every review
  finding is a `warning` by design, so blocking on errors alone would let a bundle embedding a
  literal credential exit `0`. But audit forwards render diagnostics, and every Codex bundle
  carries approximate warnings. So a warning whose code is in `AUDIT_CODES` blocks; a forwarded
  one blocks only under `--strict`. Adding a check means adding its code to `SOURCE_CHECKS`,
  `RENDERED_CHECKS`, or `BASELINE_CHECKS`, or it will neither gate CI nor appear in
  `audit.checks` — which is what tells a consumer "clean" from "not checked".
- **Audit re-emits `AB504`, `AB505`, and `AB506` rather than minting its own codes.** One
  condition keeps one ID whichever command surfaces it, or a consumer's suppression list breaks.
  It calls the packager's exported checks over a _bundle-root-relative_ inventory
  (`buildSourceInventory`): `bundle.hookFiles` paths are relative to the hook directory, so
  passing them straight through would miss `checkExecutables`' `hooks/` prefix and flag every
  scaffolded hook script. `agent init` output auditing clean is a guarded constraint.
- **`src/sarif.ts` builds its document in a load-bearing key order.** The five `md` diagnostic
  commands share `sarifDocument` with `agent audit`, and `JSON.stringify` follows insertion
  order, so reordering a key silently changes bytes every existing SARIF consumer receives.
  `tests/unit/automation.test.ts` asserts byte equality against a fixed input. `formatSarif`'s
  hardcoded `level: "error"` is contract too, not an oversight: an `Issue` carries no severity.
  The agent mapper lives separately in `src/agent/sarif.ts` because it needs three levels, no
  `region`, and `properties` — and because agent SARIF goes to stdout, not stderr.
- **Sort generated output by byte comparison, never `localeCompare`.** It is ICU-build and
  locale dependent, so a differently configured CI runner would reorder archives and manifests.
  `render.ts:897` still uses `localeCompare`; leave it (changing it would move
  `conversion-report.json` artifact order, which is observable) but do not copy it.
- **`agent add` must not rewrite `agent-bundle.yaml` unless there is a real edit.**
  `parseDocument` preserves comments but normalizes incidental whitespace, so an unconditional
  round trip would churn the file. A plain `parse` + `stringify` would delete every comment.
- **`agent doctor --output` takes a conversion root, not a package root.** A package root also
  holds catalogs, checksums, and the inventory, which `diffOutput` would report as unmanaged.
- **A snippet link is read from `Code.meta`, never by scanning the document.** That is the whole
  reason the syntax lives in the fence info string: remark reports an inner fence as characters
  inside the outer block's `value`, so a fenced example _documenting_ the syntax is unreachable
  rather than merely guarded — unlike the TOC markers, which `synchronizeToc` has to filter
  through `isLineInCodeBlock`. "Optimizing" `src/snippets.ts` into a line scan would make this
  repo's own `docs/commands/md/check-snippets.md` go live. `tests/e2e/cli.test.ts` runs
  `md check-snippets docs README.md` over this repository and asserts exit 0.
- **`MdCodeBlock.meta`, `start`, and `end` are internal.** No command projects them into a
  payload. Emitting `meta` unconditionally would change `md code-blocks -fj`, the MCP
  `list_code_blocks` tool, and `md query code-blocks` bytes for every consumer, for a field that
  is null on almost every fence — the same rule as `Artifact.origin`.
- **`md check-snippets` bounds reads and writes by different roots.** Source reads are confined
  to `config.root`, because a document under `docs/` legitimately points at `../src`; writes use
  `containmentRoot`, which for `md check-snippets docs` is `docs/` and would reject every real
  source. `--write` copies arbitrary file contents into tracked documents, so the read guards in
  `readSnippetSource` — realpath containment, regular-file, size, NUL — are the feature's
  security boundary, not hygiene. `check`/`write`/`dryRun` stay out of `COMMAND_OPTIONS` for the
  same reason.
- **The `snippets` fixer is deliberately not in the `md fix` default set.** `selectFixers([])`
  filters on `Fixer.default`; it is the only fixer whose edits are decided by files other than
  the Markdown being fixed, and a broadly-run `md fix --write` must not silently acquire that
  reach.
- **`agent test` discovers `tests/**/*.test.yaml` by convention, with no manifest key.** Adding
  one would end schema 2's "schema 1 plus `marketplace:` and `native:`, nothing else" property
  and would lock the feature out of v1 and legacy bundles, which can carry tests today. The
  directory is invisible to the parser (`assets` is read from its own configured root), and
  `buildSourceInventory` walks the whole bundle root, so the test files do enter `agent audit`'s
  inventory — deliberately, they are bundle files — without tripping a check.
- **The `agent test` tree digest is a value users paste, so its serialization is contract.**
  Artifacts sorted by byte comparison of path, each contributing
  `<path>\n<octal mode>\n<sha256>\n`, hashed. Changing the order, the separators, or what is
  included invalidates every golden digest in every bundle in the world. The command never
  writes, so there is no `--update` to regenerate them with; a mismatch reports the actual value
  in the finding and in `test.cases[].failures[].actual`. The test-file `schemaVersion` is a
  fourth hand-owned version — see `docs/contract.md`; semantic-release does not touch it.
- **`scripts run` is the only command that executes anything, and the guards are the feature.**
  What makes it acceptable is that the command is declared by name in a tracked file rather than
  discovered in analyzed content — a resolver, not an evaluator. The load-bearing rules:
  resolution stops at the git root (or a deeper `--root`) and refuses entirely outside a
  repository, `node_modules` is skipped so a vendored `.cairn.yml` cannot win by being
  nearest, the resolved `cwd` is containment-checked as well as the registry file, and `run:`
  passes forwarded arguments as separate argv entries to `sh -c` so the shell binds them to
  `$1…$n` without ever lexing them. Interpolating arguments into the body, or reaching for
  `spawn(cmd, { shell: true })`, gives that last guarantee away. `scripts` commands are absent
  from `COMMAND_OPTIONS` on purpose: config may declare what a script is, never how it is run.
  `src/serve/tools.ts` must never expose it; `tests/unit/serve-tools.test.ts` has a tripwire.
- **`run:` uses `/bin/sh`, not `$SHELL`.** A login shell may be fish or csh, neither of which
  binds positional parameters for `-c`, so honoring `$SHELL` would make a committed registry
  behave differently per machine — the exact problem the toolset exists to solve. A body needing
  bashisms sets `shell:` explicitly.
- **`scripts run` forwards the child's exit status verbatim in llm and human formats.** That is
  outside `CommandExit`'s `1 | 2` type, so the action assigns `process.exitCode` and returns
  instead of throwing. It must never call `process.exit()` — a piped `--format json` write is
  asynchronous and would be truncated. The divergence is declared through the optional
  `exitCodePassthrough` field on `CommandContract`, added rather than widening
  `ExitCodeMeaning.code`, whose `enum: [0,1,2]` is published in the `describe` schema.
  **`--ignore-exit-code` is the one flag that turns that passthrough off**, and it suppresses the
  status for _every_ outcome, a refused resolution included — `scriptsRunAction` is a wrapper
  that catches around the real body for exactly that reason. It exists because an invocation
  inline in a `SKILL.md` fails to load on any non-zero status, so a partial suppression would not
  deliver what the flag is for. The suppressed value is also what `jsonPayload` is given, so
  `--envelope`'s `exitCode` cannot contradict the process; `exit.status` keeps the real code.
- **The `-fh`/`-fj` argv rewrite in `src/cli.ts` stops at the first `--`.** Everything after it
  is forwarded to a child process untouched; rewriting there would hand the script
  `--format=json` in place of the `-fj` the user typed.
- **`loadConfig` validates `scripts:` but never stores it.** `ROOT_KEYS` must list `scripts` or a
  registry breaks every `md` command in that workspace, and the `parseScriptsBlock` call after it
  exists so a typo is an error at `md lint` rather than a surprise at `scripts run`. Keeping the
  parsed registry off `ResolvedConfig` is what keeps `serve` more than one line from exposing it.
  The chain walk in `src/scripts/resolve.ts` deliberately validates _only_ `scripts:` — an
  ancestor's malformed `urls:` block belongs to another project.
- **This repository has no `.cairn.yml`, and adding one is not free.** Any config file sets
  `config.root` to its directory, which confines the workspace — `tests/e2e/contract.test.ts`
  spawns the CLI with the repo as cwd while operating on temporary workspaces, and every one of
  those cases fails with "Directory is outside configured workspace root". Dogfooding the
  `scripts:` block means insulating that suite first.
- **`usage` counts responses, not transcript lines.** Claude Code writes one JSONL line per
  content block, each carrying an identical full copy of `message.usage`. Summing lines
  over-counts output tokens by roughly 2.5x, so `src/usage/providers/claude-code.ts` dedupes on
  `message.id` before adding anything. Tool-use blocks really are one per line and are counted
  per line. Records with `model: "<synthetic>"` are locally generated and carry no usable
  counters. `session_id` (snake) also appears alongside `sessionId` with a _different, stale_
  value — never key on it. `tests/unit/usage-parse.test.ts` pins each of these.
- **Subagent tokens come from the subagent transcript, never the parent's summary.** The
  parent's `toolUseResult.totalTokens` is the subagent's _final message only_ and understates
  real spend several-fold. `subagents/agent-*.jsonl` outnumbers main transcripts about 6:1 and
  holds more bytes, so they are scanned by default; `--no-subagents` prunes discovery.
- **A filtered `usage` import may not delete.** `--since` and `--no-subagents` prune discovery,
  so dropping rows for what such a walk did not find evicts every entry it never looked at and
  makes the next full import re-parse everything. Only a complete walk may delete — that is the
  `partial` flag in `src/usage/scan.ts`, and `tests/e2e/usage.test.ts` guards it. The rule
  survived the move from JSON shards to SQLite unchanged; only the storage did.
- **The usage store version is hand-owned, and migrated rather than discarded.** Unlike
  `src/url-cache.ts`'s private `CACHE_VERSION`, a mismatch here may not throw the file away:
  after `archive run --include transcripts` prunes the source logs, the store can be the only
  record of that usage left. `PRAGMA user_version` holds it, `src/usage/db/migrations.ts` is the
  list, a shipped migration is never edited, and a store from a newer build is **refused**, not
  opened. It is the fifth entry in the `docs/contract.md` table of hand-owned versions.
- **The usage store keeps two grains, and one test is what keeps them honest.** Providers emit
  per-occurrence `UsageEvent`s _alongside_ the day buckets they already built, never instead of
  them, so no published number depends on the event stream being complete.
  `tests/unit/usage-events.test.ts` folds the stream back with `foldDays` and asserts it
  reproduces `aggregate.days`. Adding a counter to a provider without emitting its event fails
  there rather than shipping a quietly short `event` table. `hook_error` exists because a hook's
  failure count and execution count legitimately diverge — Claude Code's `stop_hook_summary`
  reports failures with no matching execution record.
- **`usage index`'s `shards` is retained at `0`, and `bytes` is not summed.** One store replaced
  the per-project shard files, so `shards` counts something that no longer exists but is a
  required property of the published schema; `removed` now counts transcripts, not files; and
  `bytes` is the whole store's size repeated on every `caches` entry. Recorded in the registry
  `notes` and `docs/commands/usage/index.md` rather than quietly fixed, the same rule as
  `md links -fj` and `md lint-dir --summary`.
- **`usage --since`/`--until` are day-granular, deliberately.** The day rollup is what makes
  `tokens --by day` cheap, and the bounds are pushed into SQL against it; accepting an instant
  would promise a precision that rollup cannot keep, even though the `event` table could answer
  it. The lower bound also prunes the walk by file mtime before anything is opened.
- **`usage` provider capability is data, and the reports read that data.** Same rule as
  `src/agent/targets/*.ts`: `src/commands/usage.ts` must never branch on `provider.name`.
  Registering a second LLM is a module under `src/usage/providers/` plus a line in its
  `index.ts`.
- **`usage` exits 2 only under `--strict`.** Over thousands of transcripts a removed file or a
  truncated final line is routine, so those are counted under `scan` in the payload rather than
  made fatal — blocking by default would make the command useless in CI. `usage` is also absent
  from `COMMAND_OPTIONS` on purpose, like `scripts`: it reads logs outside the workspace, so a
  checked-in config file has no business steering it.
- **The fish completion script is close to 1 MB and grows with every subcommand.** Each `complete` line
  repeats the whole subcommand guard. That is fine for a shell redirect but exceeds Node's
  default `maxBuffer`, so `tests/e2e/completion.test.ts` raises it. Adding another toolset makes
  this worse; shrinking the generator would change byte-stable output a test asserts.
- **Each `usage` provider distorts its token log differently, and each is undone separately.**
  Claude Code fans one response across lines carrying identical usage (dedupe on `message.id`);
  Codex reports a **running total** per thread (difference consecutive readings — its
  `last_token_usage` is re-emitted on duplicates and summing it inflates ~4%); Antigravity
  reports a **per-request context size that is not cumulative** (sum it — it falls whenever
  context is trimmed, so differencing produces nonsense). Codex also counts cache reads _inside_
  `input_tokens`, so the cached part is subtracted out or its input reads several times high.
  `tests/unit/usage-{codex,antigravity}.test.ts` pin each. Gemini CLI needs **all three
  corrections at once**: it writes one assistant turn two to five times under a single `id`
  (dedupe on `id`), reports a per-request context size (sum it), and counts the cached prefix
  inside `input` (subtract it out). Its tool calls need a _second, different_ dedupe — the
  `toolCalls` array grows across those repeats and never shrinks, so the rule there is
  last-occurrence-wins, buffered and flushed at EOF. `tests/unit/usage-gemini-cli.test.ts` pins
  each of them.
- **Antigravity's tokens come from schema-less protobuf, and are guarded.**
  `src/usage/providers/protobuf.ts` is a hand-rolled wire reader because Google ships no
  `.proto`; the field numbers are reverse-engineered. `antigravity.ts` asserts
  `completion === thinking + output` and a prompt bound before trusting any of it, and on failure
  keeps every JSONL-derived figure while emitting no tokens. Read the JSONL (named fields) for
  everything it can answer and the database only for what exists nowhere else.
- **`node:sqlite` prints an experimental warning to stderr on import.** stderr carries the JSON
  payload whenever a command reports findings, so `loadSqlite()` in `src/sqlite.ts` suppresses it
  around the `createRequire` call — the same rule as the update notifier. A
  `tests/e2e/usage.test.ts` case asserts stderr stays empty. That loader is shared by the
  antigravity provider, which reads somebody else's database and treats every failure as a
  missing token column, and by the usage store, which owns its file and calls `requireSqlite()`
  because it cannot degrade. Do not copy it a third time.
- **A session id is unique only within its provider.** `sessionKey()` in `src/usage/events.ts`
  qualifies it; counting or grouping sessions on the bare id merges two providers' sessions when
  they mint the same UUID, which they do.
- **Only `claude-code`, `gemini-cli`, `opencode`, and `cursor` can prune subagents at discovery.**
  The first two record the thread source in the transcript's path, `opencode` records it on the
  session row, and `cursor` has it in the conversation index it builds before any turn is read;
  `codex` and `antigravity` record it inside the file, so `scan.ts` filters on the parsed `kind`
  as well. Both filters must stay.

- **OpenCode has no filesystem unit below its whole store, so both the transcript unit and its
  freshness key are synthesized.** `discover()` emits one `TranscriptFile` per `session` row with
  a `relative` of `session/<id>`; collapsing the store into one entry would destroy
  `usage sessions`, `--last`, `--project`, and the main/subagent split, because a `FileAggregate`
  carries exactly one of each. The freshness key is `MAX(message.time_updated,
part.time_updated)` with the row counts as `size` — **not** the `.db` file's stat, which is one
  value shared by every session and would invalidate all of them on any write, and **not**
  `session.time_updated`, which is measurably stale against its own messages. The store is parsed
  once and memoized on the database's path, mtime and size, because SQLite indexes none of these
  foreign keys and a per-session query would be a full table scan each time.

- **OpenCode records the same usage at three grains, and reading two of them doubles it.** The
  assistant `message`, its `step-finish` `part`, and the `session` rollup all carry the same
  figures — verified against `opencode stats`. Only the message grain is read: it survives when a
  message produced no step-finish part, and `message.id` is a primary key. Unlike Codex and
  Gemini CLI, `tokens.cache.read` is disjoint from `input` and is not subtracted. `cost` is
  dropped, because `TokenTotals` has no place for it and adding one is a store migration.

- **Never write a bundle manifest to `opencode.json`.** Unknown top-level keys there are rejected
  with `ConfigInvalidError` and the host refuses to start, which is why the OpenCode plugin
  manifest lives in `.opencode-plugin/`. It is also why `opencode` declares `policies.form: null`
  despite having a native `permission` block: `paths.project.mcp` already owns `opencode.json`,
  and both writers serialize a whole document, so declaring the policy form would clobber the MCP
  block. `PolicyForm` reserves `opencode-permission` for when the two share a merge-aware
  writer.

- **`gemini-cli` and `antigravity` share `~/.gemini` and must never claim each other's tree.**
  The former roots at `~/.gemini` guarded on `tmp/`, the latter at `~/.gemini/antigravity-cli`
  guarded on `conversations/`. Every `gemini-cli` archive set is rooted at `tmp` for the same
  reason — it is what keeps the other provider's corpus, the encrypted IDE store, and
  `oauth_creds.json` out of reach. A `gemini-cli` prompt count taken over subagent transcripts is
  wrong by a factor of fourteen: a subagent's `user` record is the instruction its parent
  injected, so prompts are counted in main transcripts only.
- **Cursor's tokens have an end date, and that is the host's doing.** `tokenCount.{inputTokens,
outputTokens}` on a `bubbleId:` record is a real per-request figure with no distortion to undo —
  the only provider needing none — but on a real corpus every nonzero one falls between
  2025-06-17 and 2025-12-23. Newer conversations carry the field zeroed and settle usage
  server-side behind `usageUuid`. So a turn whose counters are zero emits **no response event**
  (counting them would report a request per turn against no tokens for the whole modern corpus),
  and a window after 2025 correctly reports sessions and tools with no tokens. `contextTokensUsed`
  is the only live figure and is deliberately unread: it is the last turn's context size,
  overwritten each turn and excluding output, so it can be neither summed like Antigravity's nor
  differenced like Codex's. `cacheTokens` is `false` because no cache counter has ever existed in
  that schema. `tests/unit/usage-cursor.test.ts` pins each of these.
- **Cursor's conversation index is incomplete, so discovery does not use it.** `composerHeaders`
  is a recent table Cursor gated behind its own flag and never backfilled, and the legacy
  `ItemTable['composer.composerHeaders'].allComposers` beside it does not make up the difference:
  161 of the 229 token-bearing conversations on a real store are in neither, which is 61% of all
  the tokens there are to report. `discover()` therefore enumerates `composerData:` keys and both
  indexes are read only to **enrich** identity (workspace, subagent role), never to decide a
  conversation exists. Every `cursorDiskKV` read is a **key range**, not a `LIKE`, so the UNIQUE
  index on `key` is always used — that table is ~450k rows and 5 GB of values. Unlike
  `opencode.ts` the store is not reduced up front: only the cheap index is memoized, `parse`
  reads one conversation's range, and it projects its seven fields **in SQL** so a 9 KB turn body
  never crosses into JavaScript.
- **Cursor is the only provider whose files span two trees, and the only `ArchiveProfile` with a
  second root.** The usage provider roots at the Electron user-data directory, because that is
  where the store is; the plans, agent transcripts and produced files are under `~/.cursor`. On
  macOS those share only `$HOME`, and rooting a set there is the home-directory sweep
  `src/archive/sets.ts` exists to prevent — so `ArchiveProfile.altRoot` and `ArtifactSet.tree`
  were added, both optional and absent on the other five profiles. A `tree: "alt"` set
  contributes nothing when that tree is absent rather than falling back to the primary root, and
  `--logs` does not redirect it. Cursor's `root()` tries platform candidates in order rather than
  branching on `process.platform`, which is what keeps it hermetic under the `HOME`-swapping e2e
  suite. Its `state.vscdb` set matches by **exact equality**: that excludes the `-wal`/`-shm`
  sidecars and `state.vscdb.backup`, a stale 3.4 GB copy. Note that store holds
  `cursorAuth/accessToken`, so `archive run --include logs` for Cursor produces an archive to
  treat as a secret.
- **A Cursor turn is not a response, and carries no timestamp.** 134,306 assistant turns against
  3,553 prompts, because each tool step is its own turn — which is why requests come from the
  token counters and not from turns. `timingInfo.clientRpcSendTime` exists on 953 of 137,895
  turns and on 5 of the 748 that carry tokens, so it is used where present and every other event
  is anchored on the conversation's `createdAt`. Day rollups are therefore per conversation, the
  only provider where they are not per record. A spawn's role comes from joining the parent's
  `task_v2` call to the child conversation's `subagentInfo.toolCallId` — by identifier, not by
  guess — because the parent's call does not name it.
- **Every pre-rename identifier is still a read path, and the `LEGACY_*` constants are why.**
  The tool was `claude-cli` through v1.11.0. Eight constants carry the old spelling —
  `LEGACY_CONFIG_FILENAME`, `LEGACY_TOC_START`/`_END`, `LEGACY_SNIPPET_ATTRIBUTE`,
  `LEGACY_INSTALL_MANIFEST`, and a `LEGACY_BASELINE_FORMAT` in each of `src/audit-baseline.ts`
  and `src/agent/audit/baseline.ts` — plus the `CLAUDE_CLI_*` environment variables. Cairn
  **writes** the new spelling and **reads** either. `tests/unit/legacy-names.test.ts` is the
  contract for that; deleting a case there is the deliberate act of dropping compatibility,
  not cleanup. Three rules are load-bearing and not obvious:
  a TOC pair keeps the spelling it was found with (`synchronizeToc` returns the matched
  markers in `block`), because migrating them would report every legacy document as stale
  for a change that alters no table of contents, and a _mixed_ pair is `malformed`;
  `parseSnippetLink`'s two substring fast-path tests must check both spellings or a legacy
  fence reports `unlinked` without the regex ever seeing it; and `currentDepth`/`currentStack`
  in `src/scripts/execute.ts` **read** either variable while writing both, or a script that
  re-exports only the legacy name resets the counter and defeats the recursion guard.
- **Config discovery is per-directory-then-ascend, not per-name-then-ascend.** `configIn`
  tries `.cairn.yml` then `.claude-cli.yml` in one directory before moving up, and
  `src/scripts/resolve.ts` calls the same helper. Walking each name over the whole chain
  instead would let a legacy file in the repository root beat a nested `.cairn.yml`, and
  would make a directory holding both files look like two registries shadowing each other.
- **Install-manifest comparisons are split by source, deliberately.** `installManifestIn`
  is for paths read off _disk_; the `artifact.path === INSTALL_MANIFEST` equality tests in
  `src/agent/install/index.ts` compare against a plan this run just built, which never emits
  the legacy name. Widening those to accept both would be noise, not safety. A destination
  holding both manifests reads as `malformed` rather than picking one — same rule as two
  matching install scopes.
- **The bash completion's paths variable is derived, and that is the fix for a real bug.**
  `src/completion/shells.ts` builds `_CAIRN_PATHS` from `model.binary`; it was hardcoded
  `_CLAUDE_CLI_PATHS` and so was the one string in that file the binary name never reached.
  Do not re-inline it.
- **The archive's member names are content hashes, and that is a path-length defence as well as
  deduplication.** `src/archive/segments.ts` names every member `blobs/<aa>/<sha256>` — 73
  characters, comfortably inside the ustar `name` field. The real paths are not: the corpus nests
  seven deep under project slugs that are themselves absolute paths with the separators replaced,
  and `tarball` throws `TarPathTooLongError` rather than escalating to a PAX header. Storing by
  original path would fail on real data and lose deduplication at the same time.
- **`src/archive/tar-read.ts` is the first reader of a format this repo only ever wrote.** It
  pairs with `src/agent/package/tar.ts` and handles only what that writer emits; a PAX or GNU
  long-name header is refused rather than guessed at. `archive extract` and `archive verify --deep`
  both go through it, and `sealSegment` uses it to record member offsets by reading back the
  archive it just built rather than predicting them from entry sizes — predicting would duplicate
  the writer's padding rules somewhere they could drift.
- **The archive matches candidates to stored rows through one `artifactKey` helper.** The two
  sides were briefly written separately with different separators, and the result was an archive
  that re-hashed its entire corpus on every run while still producing correct output — a bug with
  no wrong answer to give it away. The separator is a NUL for the same reason `sessionKey` uses
  one: it cannot occur in either half, and a space can and does occur in a path.
- **A blob still buffered in the current segment is not the same as a stored one.** `run.ts` keeps
  `storedBlobs` and `pendingBlobs` apart because a second file with the same content as one still
  in the buffer cannot have its artifact row written yet — the `blob` row it references does not
  exist until the segment is sealed. Conflating them is a foreign key violation, not a subtle
  miscount.
- **`archive verify` exits 2 without `--strict`, and that is deliberate.** Every other `usage` and
  `archive` command treats an unreadable file as routine and reports it, because over thousands of
  artifacts a file removed mid-walk is normal. Corruption is not routine; it is the finding the
  command exists to report, so making it opt-in would defeat the point.
- **`archive run` declares `writes: true`, and `usage index` does not.** Both write only to their
  own store, but the archive's location is a durable directory the user chose and may point at
  external storage, so calling it non-writing would be misleading. `archive extract` is also a
  writer, and the only one that writes outside the archive.
- **No published schema may set `additionalProperties: false` or `$ref` another document.**
  The first would make every additive change break validating consumers; the second would make
  `cairn schema <id>` return something that cannot be compiled on its own.
  `tests/unit/contract-schemas.test.ts` enforces both.
- **The `jira adf` commands put the document on stdout and findings on stderr.** Every `agent`
  subcommand puts findings on stdout; these do the opposite, because
  `cairn jira adf to-markdown x.json > out.md` must not splice diagnostics into the document.
  Under `--format json` the payload carries both on stdout instead, which also means `-fj` on
  `jira adf from-markdown` is not "the same output in JSON" — the default already emits pure ADF,
  and `-fj` wraps it. Both divergences are recorded in the contract registry `notes`.
- **`jira` never loads project configuration.** `loadConfig` runs only when `argv[2]` is `md` or
  `serve` (`src/cli.ts`), and `argv[2]` for these is `jira`, so `.cairn.yml` has no say over a
  conversion. `src/jira/adf/read.ts` does its own bounded read rather than using `src/input.ts` —
  `requireFile` would register the document into the workspace and resolve it against
  `runtime().config.root`, which here is just the process cwd. Widening `servesWorkspace` is a
  deliberate decision, not a cleanup.
- **`adf` is a group under `jira`, so a command id here is three tokens.** Nothing in `src/`
  assumes a depth — `walkCommands` joins whatever path it walked — but three test sites used to
  reconstruct an id positionally, and now resolve it as the longest leading run the registry
  declares: the two sets in `tests/e2e/contract.test.ts` (which need **both** `jira` and
  `jira adf` listed as containers) and `commandIdFor` in `tests/e2e/envelope.test.ts`. Adding a
  fourth token anywhere needs no further change; adding a two-token toolset still works.
- **`src/jira/adf/profile.ts` is probed, not transcribed, and `tests/unit/jira-adf-profile.test.ts`
  is why it can be trusted.** That test compiles Atlassian's published JSON Schema — a
  devDependency, `@atlaskit/adf-schema`, read from nowhere else and shipped nowhere — and checks
  the content model against it in _both_ directions, so the profile can neither permit an illegal
  nesting nor needlessly degrade a legal one. It also fails the build on any (parent, child) pair
  the Markdown walk can form that has neither a legal mapping nor a degradation rule. Nothing is
  vendored or generated: `jira adf validate` reports against the profile and emits `AD100` for a
  node type it does not model, which is the same line `agent test --native` draws.
- **Deriving the content model from the ADF schema at runtime was rejected.** It trades a small
  authored table for a parser against someone else's schema structure, which a restructure breaks
  and the agreement test would have survived. The schema is also draft-04, so `Ajv2020` cannot
  compile it — hence the separate `ajv-draft-04` devDependency, test-only.
- **`from-markdown` must parse frontmatter-aware.** Under a parser without `remark-frontmatter`,
  `---\ntitle: x\n---` yields `thematicBreak, heading(2), paragraph`, so frontmatter does not go
  missing — it converts into an ADF `rule` plus a heading reading `title: x`. Plausible enough
  that nobody reports it. `parseMarkdown` has been frontmatter-aware since the phantom-heading
  fix, which is why this reads as an ordinary call rather than a special one.
- **Every `remark-stringify` option in `src/jira/adf/to-markdown.ts` is pinned.** Left at their
  defaults, a minor bump silently changes the bytes of every document the converter has produced.
  `emphasis: "_"` and `strong: "*"` also match this repo's `.markdownlintrc`, so converted
  documents lint clean where they land. `remark-stringify` is a **runtime** dependency for this
  reason; it was not one before the toolset landed.
- **Emitted ADF key order is contract**, fixed once in `src/jira/adf/serialize.ts`
  (`version`, `type`, `attrs`, `content`, `marks`, `text`, with attrs in byte order) for the same
  reason `src/sarif.ts` has a load-bearing order. `taskList`/`taskItem` `localId` is derived from
  a counter, never `crypto.randomUUID()`, or the output is untestable.
- **`jira adf` decides its own exit, never `hasFindings`.** Approximation is the expected outcome
  on almost every real Jira description, so an `error` blocks and an approximation blocks only
  under `--strict`. `ok: true` does not mean lossless.
- **An unrecognized ADF node must never fall through to "dropped."** It gets `AD100`. Dropping is
  the one degradation whose output is indistinguishable from success.
- **`AD###` is a third finding family**, alongside `AB###` and the `md` checker strings.
  `MappingQuality` and the quality-to-severity rule live in `src/mapping-quality.ts` — re-exported
  by `src/agent/types.ts` rather than defined there — so the agent and conversion families cannot
  drift. `tests/unit/diagnostic-codes.test.ts` matches `A[BDP]\d{3}`, so a new code in any of the
  three families must be documented in `docs/formats/diagnostic-codes.md` or the build fails, and a
  documented code that nothing emits fails it too.
- **The `pdf` toolset reads and never writes a PDF, and that boundary is load-bearing.** Input is a
  PDF; output is Markdown, text, or JSON. It buys no writer library in the tree, commands that are
  idempotent with respect to their input, and a coherent security posture — "parse hostile input and
  never act on it" is defensible in a way that "parse it and write the result back" is not. `pdf`
  is absent from `servesWorkspace` in `src/cli.ts` and from `COMMAND_OPTIONS`, like `usage` and
  `scripts`: a checked-in config file has no say over a document named on the command line.
- **All five `pdf` commands declare exit 2, including the three that read as pure inventory.** A PDF
  fails _per page, not per document_ — an undecodable content stream on page 47 of 300 leaves the
  other 299 good, so the command must emit them and say 47 is missing.
  `tests/unit/contract-schemas.test.ts` requires `stream.findings` to be truthy exactly when exit 2
  is declared, so the two are one decision. Unlike `jira adf inspect`, whose registry row and help
  text disagree, every `pdf` help block and docs page states a specific meaning for 2.
- **`AP200` is a notice, not an approximation, and that is what keeps `--strict` meaningful.** It
  reports which path each page took. Making "this page was untagged" itself blocking would make
  `--strict` refuse essentially every real PDF; it blocks on the per-construct losses instead.
- **`getMarkInfo()` returns a `Map`, and `getDocument({data})` detaches its input.** Reading
  `markInfo.Marked` is always `undefined` and would report every document as untagged — the
  published `.d.ts` says otherwise and is wrong. `src/pdf/read.ts` returns a `Uint8Array` it
  exclusively owns because pdf.js transfers what it is given, and Node `Buffer`s under 8 KiB are
  views into a shared pool. pdf.js also **refuses a `Buffer` outright**, so `withDocument`
  normalizes.
- **Import pdf.js as `pdfjs-dist/legacy/build/pdf.mjs`.** The package-root entry warns to use the
  legacy build in Node and then throws `hashOriginal.toHex is not a function`: it assumes a V8 with
  `Uint8Array.prototype.toHex`, which Node 22 and 23 lack.
- **`src/pdf/document.ts` captures `console`, it does not silence it, and restores it _after_
  `destroy()`.** pdf.js routes warnings to `console.warn`, which is stderr — the stream carrying
  this toolset's diagnostics, asserted empty on a clean run. Capturing is also what gives
  `pdf validate` its only signal for a rebuilt xref, a substituted font, or an unsupported filter,
  so raising verbosity to ERRORS would keep the stream clean and delete four checks. pdf.js fires
  callbacks during teardown, so restoring early lets a late warning escape.
- **Four pdf.js lookups return a `Map`, and the reflex to reach for `Object.entries` is wrong on all
  of them.** `getMarkInfo`, `getAttachments`, `getFieldObjects`, and `getJSActions` are all Maps;
  `Object.entries()` on any of them yields `[]` silently, reporting a document as untagged, with no
  attachments, or with no form. Only `getMarkInfo`'s published `.d.ts` actually lies about it, which
  is why the other three are easy to get wrong a second time.
- **`getAttachments()` carries no bytes.** Its `content` is always `undefined`; the bytes come from a
  separate `getAttachmentContent(key)` keyed by the _name-tree key_, which is a third string distinct
  from both `filename` and `rawFilename`. That split is what makes `pdf attachments`' inventory cheap
  and its extraction genuinely opt-in, so do not "simplify" it into one eager call.
- **A form field's `page` is 0-based, and `-1` when the field is attached to no page.** Every other
  page number in the toolset is 1-based. `src/pdf/forms.ts` converts once, at the boundary; the
  sentinel becomes `page: null` plus `AP312` rather than page 0. Getting this wrong reads correctly
  in every test written against the wrong value.
- **`writeAtomically`'s `wx` guards the staging file, not the destination** — the `rename` still
  replaces whatever is there. That is right for `--output`, which names one file the user asked to
  write, and wrong for extracting many attacker-named files, so `src/pdf/attachments.ts` resolves
  collisions while planning. Extraction is planned over the whole set before any write, so one
  refused destination means nothing is written at all; `archive extract` sanitizes with
  `path.basename` alone and is not the model.
- **`pdf audit` and `pdf images` are deferred, and the reason is a measurement rather than a
  preference.** pdf.js's public API cannot see `/Launch`, `/SubmitForm`, `/ImportData`, or a
  non-JavaScript `/OpenAction`: `collectActions` filters on `isName(entry.get("S"), "JavaScript")`
  and `parseDestDictionary` drops `SubmitForm` through its `default:` branch, so a document that
  launches a process on open and exfiltrates form data audits _clean_. Images likewise arrive already
  decoded to RGBA, so neither the original bytes nor the filter name is reachable. Both commands need
  an object-layer reader (a lexer, a brute-force `N G obj` index, and `/ObjStm` inflation — modern
  producers use object streams heavily, 876 in one real manual). Do not ship either on the public API
  alone; a security command with silent blind spots is the indistinguishable-from-success failure in
  the worst possible place.
- **The PDF MCP tools live in `src/serve/pdf-tools.ts` and register through `SERVE_TOOLS`.** They are
  confined to `--root` exactly like the Markdown tools, which is a real narrowing accepted on purpose
  rather than adding a second boundary. Nothing there writes — `list_pdf_attachments` inventories and
  `--extract` has no equivalent — and no handler may call a command action, because those
  `terminate()` and would kill a long-lived stdio server. `src/serve/types.ts` exists so that module
  can implement `ServeTool` without importing the array it registers into. `cairn serve mcp` is
  registered by `plugins/cairn-markdown` **and no other plugin**: one server carries every toolset's
  tools, so a second registration hands a host that installs both the same seventeen tools twice.

## Commits

Conventional Commits are required — semantic-release derives the version from them, and
both a `commit-msg` hook and a CI job reject malformed messages. `feat:` → minor,
`fix:`/`perf:` → patch, `!`/`BREAKING CHANGE:` → major, everything else → no release.

## Before pushing

```bash
npm run format:check && npm run lint && npm run typecheck && npm test
```
