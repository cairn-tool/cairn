import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import Ajv2020 from "ajv/dist/2020.js";
import addFormatsImport from "ajv-formats";
import {
  inlineAgentBundleSchema,
  installableAgentBundlesSchema,
} from "@cairn-tool/agent-bundle-schema";
import { SCHEMA_BY_ID } from "../../src/contract/schemas/index.js";

const exec = promisify(execFile);
const cli = path.resolve("dist/cli.js");
const temporary: string[] = [];

const addFormats = addFormatsImport as unknown as (instance: Ajv2020) => Ajv2020;
const ajv = addFormats(new Ajv2020({ allErrors: true, strict: false }));
const validateResult = ajv.compile(SCHEMA_BY_ID.get("agent-result")!.schema);
const validateInline = ajv.compile(inlineAgentBundleSchema);
const validateInstallable = ajv.compile(installableAgentBundlesSchema);

function temp(prefix: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  temporary.push(root);
  return root;
}

async function run(
  ...args: string[]
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  try {
    const result = await exec("node", [cli, ...args]);
    return { ...result, exitCode: 0 };
  } catch (error) {
    const result = error as { stdout?: string; stderr?: string; code?: number };
    return { stdout: result.stdout ?? "", stderr: result.stderr ?? "", exitCode: result.code ?? 1 };
  }
}

function errorsOf(validate: { errors?: unknown[] | null }): string[] {
  return (validate.errors ?? []).map((error) => JSON.stringify(error));
}

afterEach(() => {
  for (const root of temporary.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("agent docs", () => {
  it("emits an agent result carrying the artifact", async () => {
    const result = await run("agent", "docs", "plugins/cairn-markdown", "--format", "json");
    expect(result.exitCode).toBe(0);
    const payload = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(validateResult(payload), errorsOf(validateResult).join("\n")).toBe(true);
    expect(payload.command).toBe("docs");
    const docs = payload.docs as Record<string, unknown>;
    expect(docs.kind).toBe("inline-agent-bundle");
    expect(validateInline(docs), errorsOf(validateInline).join("\n")).toBe(true);
  });

  it("writes a standalone artifact whose envelope names the schema it conforms to", async () => {
    const out = path.join(temp("agent-docs-e2e-"), "artifact.json");
    const result = await run("agent", "docs", "plugins/cairn-markdown", "--out", out);
    expect(result.exitCode).toBe(0);

    const document = JSON.parse(fs.readFileSync(out, "utf8")) as Record<string, unknown>;
    // The envelope's `schema` is how a consumer knows which document to
    // validate `data` against, so it has to be the artifact schema's own `$id`
    // rather than the agent-result schema the command's stdout conforms to.
    expect(document.schema).toBe(inlineAgentBundleSchema.$id);
    expect(document.command).toBe("agent docs");
    expect(validateInline(document.data), errorsOf(validateInline).join("\n")).toBe(true);
  });

  it("documents the inline form by default and the installable form on request", async () => {
    const inline = await run("agent", "docs", "plugins/cairn-markdown", "--format", "json");
    const plugin = await run(
      "agent",
      "docs",
      "plugins/cairn-markdown",
      "--profile",
      "plugin",
      "--format",
      "json",
    );
    const profilesOf = (raw: string): string[] => {
      const docs = (JSON.parse(raw) as { docs: { bundle: { targets: { profile: string }[] } } })
        .docs;
      return [...new Set(docs.bundle.targets.map((render) => render.profile))];
    };
    // "Inline" is the project profile. Defaulting to `both` would document a
    // form of the bundle this artifact kind is explicitly not about.
    expect(profilesOf(inline.stdout)).toEqual(["project"]);
    expect(profilesOf(plugin.stdout)).toEqual(["plugin"]);
  });

  it("carries each component's body and bundle-relative paths", async () => {
    const result = await run("agent", "docs", "plugins/cairn-markdown", "--format", "json");
    const skills = (
      JSON.parse(result.stdout) as {
        docs: { bundle: { components: { skills: { source: string; body: string }[] } } };
      }
    ).docs.bundle.components.skills;
    expect(skills.length).toBeGreaterThan(0);
    for (const skill of skills) {
      expect(skill.body.length).toBeGreaterThan(0);
      // An absolute path would leak the machine that built the artifact and
      // change its fingerprint on every rebuild.
      expect(path.isAbsolute(skill.source)).toBe(false);
      expect(skill.source.startsWith("skills/")).toBe(true);
    }
  });

  it("reports an invocation error as an AB000 result on stdout", async () => {
    const result = await run("agent", "docs", temp("agent-docs-empty-"), "--format", "json");
    expect(result.exitCode).toBe(1);
    const payload = JSON.parse(result.stdout) as {
      ok: boolean;
      diagnostics: { code: string }[];
    };
    expect(payload.ok).toBe(false);
    expect(payload.diagnostics.map((item) => item.code)).toEqual(["AB000"]);
  });
});

describe("agent collection-docs", () => {
  it("covers every bundle the spec names in one artifact", async () => {
    const out = path.join(temp("agent-collection-docs-e2e-"), "artifact.json");
    const result = await run("agent", "collection-docs", "agent-marketplace.yaml", "--out", out);
    expect(result.exitCode).toBe(0);

    const document = JSON.parse(fs.readFileSync(out, "utf8")) as {
      schema: string;
      data: {
        bundles: { name: string; targets: { profile: string }[] }[];
        marketplace: { name: string; targets: string[] };
      };
    };
    expect(document.schema).toBe(installableAgentBundlesSchema.$id);
    expect(validateInstallable(document.data), errorsOf(validateInstallable).join("\n")).toBe(true);

    // The repository's own eight bundles are the end-to-end proof: a collection
    // artifact that dropped one would still validate.
    const spec = fs.readFileSync("agent-marketplace.yaml", "utf8");
    const declared = [...spec.matchAll(/^\s*-\s*path:\s*(\S+)/gm)].length;
    expect(document.data.bundles).toHaveLength(declared);
    expect(document.data.bundles.map((bundle) => bundle.name)).toContain("cairn-agent");

    for (const bundle of document.data.bundles)
      expect([...new Set(bundle.targets.map((render) => render.profile))]).toEqual(["plugin"]);
  });

  it("narrows each bundle to the targets its own spec entry includes", async () => {
    const result = await run(
      "agent",
      "collection-docs",
      "agent-marketplace.yaml",
      "--format",
      "json",
    );
    expect(result.exitCode).toBe(0);
    const payload = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(validateResult(payload), errorsOf(validateResult).join("\n")).toBe(true);
    expect(payload.command).toBe("collection-docs");

    const artifact = payload.collectionDocs as {
      marketplace: { targets: string[] };
      bundles: { targets: { target: string }[] }[];
    };
    const collectionTargets = new Set(artifact.marketplace.targets);
    for (const bundle of artifact.bundles)
      for (const render of bundle.targets) expect(collectionTargets.has(render.target)).toBe(true);
  });

  it("reports a missing spec as an AB000 result on stdout", async () => {
    const missing = path.join(temp("agent-collection-docs-missing-"), "nope.yaml");
    const result = await run("agent", "collection-docs", missing, "--format", "json");
    expect(result.exitCode).toBe(1);
    const payload = JSON.parse(result.stdout) as { diagnostics: { code: string }[] };
    expect(payload.diagnostics.map((item) => item.code)).toEqual(["AB000"]);
  });
});
