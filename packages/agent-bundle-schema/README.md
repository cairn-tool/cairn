# @cairn-tool/agent-bundle-schema

The JSON Schemas for the agent bundle documentation artifacts `cairn` produces, plus the
TypeScript types generated from them and an Ajv validator.

A documentation pipeline that consumes these artifacts should depend on this package rather than
on the CLI: the schemas are the contract, and they are published separately so validating an
artifact needs nothing else.

## The two artifacts

| Schema id                   | Produced by                   | Covers                                               |
| --------------------------- | ----------------------------- | ---------------------------------------------------- |
| `inline-agent-bundle`       | `cairn agent docs`            | the one bundle a repository installs into itself     |
| `installable-agent-bundles` | `cairn agent collection-docs` | every bundle a repository publishes, in one document |

"Inline" is the `project` output profile: files merged into a repository's own dot-directories.
"Installable" is the `plugin` profile: a self-contained directory with its own manifest, which a
host installs from a marketplace. A repository has at most one of the first and any number of the
second, which is why one artifact carries a bundle and the other carries a list.

## Install

```sh
npm install @cairn-tool/agent-bundle-schema
```

## Use

```ts
import { validate, inlineAgentBundleSchema } from "@cairn-tool/agent-bundle-schema";
import type { InlineAgentBundleArtifact } from "@cairn-tool/agent-bundle-schema";

const document = JSON.parse(await readFile("artifact.json", "utf8"));

// The artifact file is cairn's result envelope; the payload is its `data`.
const result = validate("inline-agent-bundle", document.data);
if (!result.valid) throw new Error(JSON.stringify(result.errors, null, 2));

const artifact = document.data as InlineAgentBundleArtifact;
for (const skill of artifact.bundle.components.skills ?? []) console.log(skill.name);
```

Each schema document is self-contained, so it can be handed to any validator on its own:

```ts
import { Ajv2020 } from "ajv/dist/2020.js";
new Ajv2020({ strict: false }).compile(inlineAgentBundleSchema);
```

## Versions

Three, and they move independently.

- **`$id`** carries the schema major: `https://github.com/cairn-tool/cairn/schema/v1/<name>.json`.
  It is an identifier, not a fetchable URL — `cairn schema <id>` retrieves the document.
- **`schemaVersion`** inside a payload is the semantic version of the payload format, exported here
  as `PAYLOAD_SCHEMA_VERSION`. A consumer accepts a higher patch or minor and rejects a higher
  major.
- **The package version** is set by semantic-release from the commit history and matches the
  `@cairn-tool/cairn` release it ships with. It says nothing about the format.

No schema sets `additionalProperties: false`. Adding a property is a non-breaking change and a
consumer must ignore what it does not recognize.

## Source of truth

The schemas are hand-written in [`spec/v1/`](../../spec/v1) at the repository root, and everything
in this package is generated from them by `npm run codegen`. Do not edit `schemas/` or
`src/generated/` — `npm run codegen:check` fails CI when they have drifted.

## License

MIT
