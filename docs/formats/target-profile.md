# Target profile format

A **target conformance profile** describes everything the renderer needs to know about one
host: its paths, its manifest, its hook document shape, its model and tool vocabularies, its
rule form, its catalog spec, its install locations, and the complete set of output paths it may
produce.

The renderer reads that data rather than branching on the target. That is the load-bearing
rule, and the conformance fixtures enforce the half of it that matters most: they fail the
build if a rendered path is one no profile declares. What
[`agent specs`](../commands/agent/specs.md) publishes therefore cannot drift from what
`agent convert` produces.

**Two branches on the target name remain in `src/agent/render.ts`**, and it is worth knowing
which: Codex renders a custom agent as TOML rather than Markdown, and Cursor inlines a skill
into its agent documents. Both are document _shapes_ rather than tabular facts, and neither has
a second target to generalize against yet. Everything else — paths, manifest location, hook
document name and shape, the command-policy form, the skill invocation form, the MCP
destination — is read from the profile. Adding a branch for anything in that second list is how
the next target quietly inherits some other host's output.

Profiles live at `src/agent/targets/<id>.ts` as **TypeScript modules, not JSON**. `tsconfig`
sets `rootDir: "src"` with no `resolveJsonModule`, so a top-level data directory would never
reach `dist` and the published package would silently lack it.

## Schema version

`PROFILE_SCHEMA_VERSION` is a **hand-owned** version of the profile structure itself,
independent of the package version, the contract version, the bundle version, and the test-file
version. It is currently `"2"`. A profile whose `schemaVersion` does not match is reported as
invalid.

## Structure

```ts
interface TargetProfile {
  schemaVersion: string;
  id: AgentTarget;
  host: HostProfile;
  profiles: AgentProfile[]; // "plugin" | "project"
  manifest: ManifestProfile;
  paths: PathProfile;
  placeholders: PlaceholderProfile;
  hooks: HookProfile;
  models: ModelProfile;
  tools: ToolProfile;
  rules: RuleProfile;
  policies: PolicyProfile;
  skills: SkillProfile;
  outputs: Record<AgentProfile, OutputPattern[]>;
  features: Record<FeatureKey, FeatureProfile>;
  marketplace?: MarketplaceProfile; // optional so adding it stayed additive
  install?: InstallProfile; // likewise
}
```

`marketplace` and `install` are optional on purpose: a consumer that has not been updated sees
a new key rather than a changed shape. Every shipped profile defines both, except that Codex
records `install.user: null`.

## `host`

What the profile was written against. Every field here is declarative; **Cairn never executes
any of it.**

| Field                   | Meaning                                                                |
| ----------------------- | ---------------------------------------------------------------------- |
| `displayName`           | human-readable host name                                               |
| `documentationRevision` | ISO date of the target documentation this was written against          |
| `minimumVersion`        | below this the profile is known to be wrong; `null` when not recorded  |
| `verifiedThrough`       | highest host version verified; `null` when not recorded                |
| `versionCommand`        | declared for a **caller** to run                                       |
| `nativeValidator`       | declared for a caller to run; `{ command, readOnly: true, appliesTo }` |

`agent doctor` reports a `HostStatus` — `unknown`, `unverified`, `below-minimum`, `verified`,
or `newer` — against a version the caller supplies via `--host-version`. It never spawns a
process, so its answer does not depend on what happens to be installed locally.

`{dir}` in a `nativeValidator` command is substituted with the generated `<target>/<profile>`
directory.

## `manifest`

```ts
interface ManifestProfile {
  directory: string | null; // null when the target has no plugin manifest
  file: string;
  fields: Array<{ name: string; required: boolean; support: FeatureSupport }>;
  impliedFields?: string[];
}
```

**`impliedFields` is the subtle one.** It names manifest keys the host derives from the plugin
layout on its own, so the renderer must leave them out. Declaring one is not merely redundant,
it is an error — and for Claude Code neither kind is caught by `claude plugin validate`:

- `agents` accepts a list of files and rejects the component directory the renderer would name,
  which fails the whole manifest
- `hooks` is for _additional_ hook files; naming the standard `hooks/hooks.json` the host has
  already loaded is a duplicate, and the plugin's hooks are dropped

Omitting them is what makes `agents/` and `hooks/hooks.json` load.

## `paths`

```ts
interface PathProfile {
  plugin: { skills; hooks; hooksFile; agents: string | null; assets; mcp: string | null };
  project: { skills; agents; rules; policies; mcp; assets };
  namespacePluginSkills: boolean;
}
```

A `null` root means the target cannot host that component in that profile — Codex's
`plugin.agents` is `null`, and rendering an agent into a Codex plugin is refused with `AB340`
rather than written somewhere the host will never look.

`plugin.hooks` is the directory hook _scripts_ are written into; `plugin.hooksFile` is the hook
_declaration_ document, relative to the plugin root. They are separate because a host may put
the document at the plugin root while its scripts live in a subdirectory.

`plugin.mcp` and `project.mcp` are the MCP destinations, and the renderer reads them. It used to
hardcode `.mcp.json` with one special case for Cursor, which meant any new target emitted a path
its own profile did not declare — a conformance failure at best and a silently ignored file at
worst.

`namespacePluginSkills` is `true` only for Cursor, where a plugin skill directory is
`skills/<bundle>-<skill>/`.

## `placeholders`

```ts
interface PlaceholderProfile {
  bundleRoot: Record<AgentProfile, string>;
  arguments: "native" | "advisory" | "prose";
  rootVariables: string[];
}
```

`arguments` has three modes, and each of the three targets uses a different one:

| Mode       | Behavior                                                         | Target      |
| ---------- | ---------------------------------------------------------------- | ----------- |
| `native`   | the host substitutes `$ARGUMENTS`; nothing is added              | Claude Code |
| `advisory` | the token stays, and a prose hint is appended beside it          | Cursor      |
| `prose`    | the token is replaced outright by explanatory text, with `AB302` | Codex       |

## `hooks`

```ts
interface HookProfile {
  events: Record<PortableHookEvent, string | null>; // null = inexpressible
  envelope: "hooks" | "versioned" | "named";
  handlerShape: "claude-nested" | "flat" | "nested-for-matcher-events";
  matcherEvents: PortableHookEvent[];
  supportedProtocols: string[];
}
```

The four portable events are `session-start`, `pre-tool-use`, `post-tool-use`, and `stop`. A
`null` mapping means the target cannot express that event, and a bundle using it raises `AB320`
unless a target override supplies one.

`envelope: "versioned"` wraps handlers in `{ version: 1, hooks }`; `"hooks"` emits `{ hooks }`.
`handlerShape: "claude-nested"` wraps each handler in `{ matcher, hooks: [{ type: "command", … }] }`;
`"flat"` emits it as-is with the transport keys stripped.

## `policies` and `skills`

Both name a _form_ rather than a path, and both accept `null` for a host that has no such
surface at all.

```ts
interface PolicyProfile {
  form: "claude-permissions" | "codex-prefix-rules" | "cursor-hooks" | "opencode-permission" | null;
}
interface SkillProfile {
  invocationPolicy: "frontmatter-flag" | "openai-yaml" | "advisory" | null;
}
```

`policies.form` decides how a command policy is written, into the surface
`paths.project.policies` names. The forms disagree about what that surface is — Claude Code and
Cursor name a file, Codex names the directory its rules file lives in — and each form reads it
the way its own host does.

`null` is not a gap to be filled in later; it is the honest answer for a host with no native
command-policy format, and it emits `AB361`. Before this was profile data the renderer picked
the form by target name with an unguarded `else`, which handed every target that was neither
Claude Code nor Cursor a `.codex/rules/bundle.rules` it does not read — output that looks right
and does nothing, at a path its own profile does not declare.

`skills.invocationPolicy` decides how "do not invoke this implicitly" is expressed:
`frontmatter-flag` sets a key on the skill document, `openai-yaml` writes a sidecar policy file,
and `advisory` can only say so in prose and emits `AB310`. `null` behaves as `advisory`.

## `models`, `tools`, `rules`

```ts
interface ModelProfile {
  support: FeatureSupport;
  classes: Record<ModelClass, string | null>;
}
interface ToolProfile {
  support: FeatureSupport;
  capabilities: Record<ToolCapability, string[]> | null;
}
interface RuleProfile {
  exactActivation: RuleActivation[];
  approximateActivation: RuleActivation[]; // renders, but not faithfully
  form: "mdc" | "markdown" | "aggregated-agents-md" | null;
}
```

Model classes are `fast`, `balanced`, `capable`, `inherit`; a `null` native id means the target
has no model field. Tool capabilities are `read`, `write`, `shell`, `web`; `capabilities: null`
means restriction is not expressible natively.

An activation in neither list is unsupported.

## `outputs`

```ts
interface OutputPattern {
  feature: FeatureKey | "manifest";
  pattern: string;
}
```

A POSIX path relative to `<output>/<target>/<profile>`. Grammar:

| Token    | Matches                                 |
| -------- | --------------------------------------- |
| `{name}` | exactly one path segment                |
| `*`      | part of one segment                     |
| `**`     | any remaining suffix, including nothing |

A trailing `/**` also matches the bare directory prefix. Patterns must be relative POSIX paths
that do not escape the target root; a validator rejects a leading `/`, a backslash, or a `..`
segment.

**These patterns are enforced.** `agent doctor` reports every rendered path no pattern
describes, and the conformance fixtures fail the build on one. That is what makes a hardcoded
path in the renderer unshippable.

## `features`

```ts
interface FeatureProfile {
  support: "exact" | "approximate" | "unsupported" | "native";
  profiles: AgentProfile[];
  summary: string; // one line, the machine-generated compatibility cell
  surface: string | null;
  diagnostics: string[]; // codes this target may emit for this feature
}
```

The nine feature keys are `skills`, `agents`, `rules`, `hooks`, `policies`, `mcp`, `assets`,
`placeholders`, and `native`.

`support` is the **best** quality the feature reaches on this target. An individual occurrence
may be worse — a malformed input or an unsupported output profile is reported per diagnostic —
but never better, which is exactly what the conformance suite asserts.

`summary` replaces what would otherwise be a free-text compatibility table maintained by hand;
`agent compat` is generated from it.

## `marketplace`

Catalog structure is tabular target behavior, so it belongs in the profile rather than in the
packager — the same rule that keeps paths and hook events out of the renderer.

```ts
interface MarketplaceProfile {
  catalog: Record<"repo" | "local", { directory: string; file: string } | null>;
  entriesKey: string;
  documentFields?: MarketplaceEntryField[];
  entryFields: MarketplaceEntryField[];
  assets: Array<{
    role: "icon" | "screenshot";
    required: boolean;
    extensions: string[];
    maxBytes: number | null;
  }>;
  archiveName: string; // {name}, {version}, {target}, {profile} are substituted
}
```

A field names where its value comes from and how it is reshaped:

```ts
type MarketplaceFieldSource =
  | { from: "manifest"; field: string }
  | { from: "marketplace"; field: string }
  | { from: "computed"; value: "source" };

type MarketplaceFieldTransform = "identity" | "name" | "first";
```

`transform` exists because targets disagree about the shape of the same underlying datum.
`marketplace.publisher` becomes Claude Code's `owner`/`author` **object**, Codex's required
`publisher` **string** (`name`), and Cursor's optional `author` **string**; and
`marketplace.categories` becomes Claude Code's singular `category` (`first`) but Codex's and
Cursor's whole list. Naming the reshape here keeps that disagreement in the profile instead of
as a field-name check inside the packager.

`documentFields` are written at the catalog document's top level — the marketplace's own
identity, as opposed to a plugin entry's. Only Claude Code declares any.

A target with no `marketplace` spec is skipped by `agent package` rather than given an invented
catalog.

## `install`

```ts
interface InstallLocation {
  root: string; // "~"-prefixed for user scope; relative for project
  layout: "plugin-dir" | "merge" | "marketplace";
  profile: AgentProfile;
  activation: { file: string; form: "claude-enabled-plugins" } | null;
}
interface InstallProfile {
  user: InstallLocation | null;
  project: InstallLocation | null;
}
```

| Layout        | Meaning                                           |
| ------------- | ------------------------------------------------- |
| `plugin-dir`  | a plain plugin directory the host auto-scans      |
| `merge`       | rendered files merged into an existing tree       |
| `marketplace` | a local marketplace the host has to be told about |

`activation: null` means the root is auto-scanned and needs no edit. Only Claude Code's
user-scope marketplace declares one, which is why `--register` exists and is the only flag that
edits host configuration.

A `null` location means the scope is unsupported. Codex records `install.user: null` because
its project rules root is `AGENTS.md`, and a user-scope merge would clobber `~/AGENTS.md`.

## Validation

`validateProfile` returns the reasons a profile is internally inconsistent, and the conformance
suite fails on a non-empty result. It checks:

- `schemaVersion` matches `PROFILE_SCHEMA_VERSION`
- at least one output profile is declared
- every one of the nine features is declared, with a non-empty summary
- every declared diagnostic code matches `AB\d{3}`
- no feature names an output profile the target does not support
- every supported output profile declares at least one output pattern
- no output pattern is absolute, uses backslashes, or contains `..`
- host versions parse as semantic versions, and `minimumVersion <= verifiedThrough`
- install layouts, profiles, roots, and activation forms are known and in-scope
- `policies.form` and `skills.invocationPolicy` are a known form or `null`
- `hooks.matcherEvents` names only portable events, and is non-empty whenever `handlerShape`
  is `nested-for-matcher-events`

## Related

- [`agent specs`](../commands/agent/specs.md) — publishes every profile as JSON
- [`agent doctor`](../commands/agent/doctor.md) — checks a bundle and a tree against them
- [`agent compat`](../commands/agent/compat.md) — the generated compatibility view
- Per-target detail: [Claude Code](../providers/claude-code/agent-bundles.md),
  [Codex](../providers/codex/agent-bundles.md), [Cursor](../providers/cursor/agent-bundles.md)
