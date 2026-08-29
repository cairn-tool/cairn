import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig, type FrontmatterRulesConfig } from "../../src/config.js";
import { FrontmatterValidator } from "../../src/frontmatter-validation.js";
import { Workspace, parseFrontmatter } from "../../src/workspace.js";

let directory: string;
beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), "cairn-frontmatter-"));
});
afterEach(() => {
  fs.rmSync(directory, { recursive: true, force: true });
});
const rules = (values: Partial<FrontmatterRulesConfig> = {}): FrontmatterRulesConfig => ({
  required: [],
  prohibited: [],
  types: {},
  allowedValues: {},
  formats: {},
  patterns: {},
  unique: [],
  ...values,
});

describe("frontmatter validation", () => {
  it("distinguishes missing, malformed, non-mapping, and valid frontmatter", () => {
    expect(parseFrontmatter("# No\n").status).toBe("missing");
    expect(parseFrontmatter("---\nbroken: [\n---\n").status).toBe("malformed");
    expect(parseFrontmatter("---\n- item\n---\n").status).toBe("non-mapping");
    expect(parseFrontmatter("---\ntitle: Hello\n---\n").status).toBe("valid");
  });

  it("applies schema formats, nested shortcuts, and workspace uniqueness", () => {
    const schema = path.join(directory, "schema.yml");
    fs.writeFileSync(
      schema,
      "type: object\nif:\n  properties:\n    kind: {const: post}\nthen:\n  required: [date]\n",
    );
    const one = path.join(directory, "one.md");
    const two = path.join(directory, "two.md");
    fs.writeFileSync(one, "---\nid: same\nkind: post\ndate: nope\nmeta:\n  state: bad\n---\n");
    fs.writeFileSync(two, "---\nid: same\nkind: note\nsecret: true\n---\n");
    const workspace = new Workspace(loadConfig({ disabled: true }, directory));
    const validator = new FrontmatterValidator(
      rules({
        required: ["meta.state"],
        prohibited: ["secret"],
        allowedValues: { "meta.state": ["ready"] },
        formats: { date: "date" },
        unique: ["id"],
      }),
      schema,
    );
    const issues = validator.validateMany([workspace.document(one), workspace.document(two)]);
    expect(issues.some((issue) => issue.checker === "frontmatter/format")).toBe(true);
    expect(issues.filter((issue) => issue.checker === "frontmatter/unique")).toHaveLength(2);
    expect(issues.some((issue) => issue.checker === "frontmatter/prohibited")).toBe(true);
    expect(issues.some((issue) => issue.checker === "frontmatter/required")).toBe(true);
  });
});
