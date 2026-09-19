#!/usr/bin/env node
/**
 * Builds the published artifact schemas and their TypeScript model types from spec/v1.
 *
 * Two things happen here, and the first is the reason the second is trustworthy.
 *
 * `spec/v1/_common.json` holds the definitions both artifacts share -- a bundle, a component, a
 * render matrix entry -- so they are authored once. It is never published: a consumer validating
 * an artifact should need exactly one document, not two. So the shared `$defs` are inlined into
 * each artifact schema here, and only the ones that artifact actually reaches.
 *
 * The types are then generated from the composed schemas rather than hand-written beside them,
 * and `src/agent/docs/` is typed as those generated types. That makes `tsc` -- not a test -- the
 * thing that catches a payload drifting from the schema it claims to conform to.
 *
 *   node scripts/codegen.mjs            rewrite the composed schemas and generated types
 *   node scripts/codegen.mjs --check    exit 1 if any is out of date
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import prettier from "prettier";
import { compile } from "json-schema-to-typescript";

const ROOT = new URL("..", import.meta.url).pathname;
const SPEC = join(ROOT, "spec/v1");
const PACKAGE = join(ROOT, "packages/agent-bundle-schema");

const COMMON_ID = "https://github.com/cairn-tool/cairn/schema/v1/_common.json";
const COMMON_REF = `${COMMON_ID}#/$defs/`;

/** Artifact schemas, in the order their types are emitted. */
const ARTIFACTS = [
  { id: "inline-agent-bundle", rootName: "InlineAgentBundleArtifact" },
  { id: "installable-agent-bundles", rootName: "InstallableAgentBundlesArtifact" },
];

const SCHEMA_BANNER =
  "Composed from spec/v1 by `npm run codegen` -- do not edit. The shared definitions live in spec/v1/_common.json.";

const TYPES_BANNER = `/*
 * GENERATED FILE -- do not edit.
 *
 * Produced from spec/v1 by \`npm run codegen\`. Edit the spec, then regenerate;
 * \`npm run codegen:check\` fails CI when the two have drifted.
 */
`;

const check = process.argv.includes("--check");
const stale = [];

/**
 * The file's contents, or null when it is not there.
 *
 * Reads and handles the absence rather than asking first: an `existsSync` before the read is a
 * race CodeQL flags as `js/file-system-race`, and the answer it returns is stale the moment it
 * comes back.
 */
function readIfPresent(path) {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

function settle(path, contents) {
  const existing = readIfPresent(path);
  if (existing === contents) return;
  if (check) {
    stale.push(relative(ROOT, path));
    return;
  }
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, contents, "utf8");
}

function read(name) {
  return JSON.parse(readFileSync(join(SPEC, `${name}.json`), "utf8"));
}

/**
 * Rewrites every `$ref` into `_common.json` to a local one, recording the definition names as it
 * goes. Returns a fresh value; the input is not mutated, so a definition can be walked for its own
 * refs without the caller's copy changing underneath it.
 */
function localize(node, found) {
  if (Array.isArray(node)) return node.map((item) => localize(item, found));
  if (!node || typeof node !== "object") return node;
  const out = {};
  for (const [key, value] of Object.entries(node)) {
    if (key === "$ref" && typeof value === "string") {
      if (value.startsWith(COMMON_REF)) {
        const name = value.slice(COMMON_REF.length);
        found.add(name);
        out.$ref = `#/$defs/${name}`;
        continue;
      }
      if (value.startsWith("#/$defs/")) found.add(value.slice("#/$defs/".length));
      out.$ref = value;
      continue;
    }
    out[key] = localize(value, found);
  }
  return out;
}

/** Inlines the shared definitions an artifact reaches, transitively. */
function composeArtifact(artifact, common) {
  const reached = new Set();
  const composed = localize(artifact, reached);

  const defs = { ...(composed.$defs ?? {}) };
  const pending = [...reached];
  const resolved = new Set(Object.keys(defs));

  while (pending.length > 0) {
    const name = pending.shift();
    if (resolved.has(name)) continue;
    resolved.add(name);
    const definition = common.$defs[name];
    if (!definition)
      throw new Error(`${artifact.$id} references '${name}', which _common.json does not define`);
    // A definition the artifact declares itself would be silently replaced here, so refuse
    // instead. The same rule the kps-docs manifest composer applies: prefix one of them.
    if (composed.$defs && Object.hasOwn(composed.$defs, name))
      throw new Error(`Definition '${name}' is declared both in ${artifact.$id} and _common.json`);
    const nested = new Set();
    defs[name] = localize(definition, nested);
    for (const ref of nested) if (!resolved.has(ref)) pending.push(ref);
  }

  // `$defs` last, and sorted, so the composed file has a stable shape no matter what order the
  // walk happened to reach things in.
  delete composed.$defs;
  return {
    ...composed,
    description: `${composed.description} ${SCHEMA_BANNER}`,
    $defs: Object.fromEntries(
      Object.entries(defs).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
    ),
  };
}

const common = read("_common");
const prettierConfig = await prettier.resolveConfig(join(ROOT, "package.json"));

const composed = new Map(ARTIFACTS.map(({ id }) => [id, composeArtifact(read(id), common)]));

for (const [id, schema] of composed)
  settle(
    join(PACKAGE, `schemas/${id}.json`),
    await prettier.format(JSON.stringify(schema), { ...prettierConfig, parser: "json" }),
  );

// Both artifacts are compiled as one document rather than one pass each. Two passes would emit
// every shared definition twice, and de-duplicating the text afterwards is not safe: a
// declaration's doc comment precedes it, so splitting on the declarations detaches each comment
// from the type it documents and drops the last one entirely. Compiling once means the generator
// does the de-duplication itself, and the doc comments stay attached.
const defs = {};
for (const { id, rootName } of ARTIFACTS) {
  const artifact = composed.get(id);
  for (const [name, definition] of Object.entries(artifact.$defs)) {
    if (defs[name] && JSON.stringify(defs[name]) !== JSON.stringify(definition))
      throw new Error(`Shared definition '${name}' differs between artifacts`);
    defs[name] = definition;
  }
  // The generator names a type from its `title`, and the artifact titles are prose. Name them
  // here so the published type names are the ones `src/agent/docs/` is written against.
  const root = { ...artifact, title: rootName };
  delete root.$id;
  delete root.$schema;
  delete root.$defs;
  defs[rootName] = root;
}

const combined = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  title: "AgentBundleArtifact",
  description: "Either of the agent bundle documentation artifacts, discriminated by `kind`.",
  anyOf: ARTIFACTS.map(({ rootName }) => ({ $ref: `#/$defs/${rootName}` })),
  $defs: defs,
};

const types = await compile(combined, "AgentBundleArtifact", {
  bannerComment: "",
  declareExternallyReferenced: true,
  additionalProperties: false,
  enableConstEnums: false,
});

settle(
  join(PACKAGE, "src/generated/types.ts"),
  await prettier.format(TYPES_BANNER + types, { ...prettierConfig, parser: "typescript" }),
);

if (check && stale.length > 0) {
  console.error("These generated sources are out of date. Run `npm run codegen`:\n");
  for (const path of stale) console.error(`  ${path}`);
  process.exit(1);
}

console.log(check ? "generated sources are current" : "generated sources rebuilt");
