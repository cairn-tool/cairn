import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  CONFIG_FILENAME,
  LEGACY_CONFIG_FILENAME,
  configIn,
  findConfig,
  loadConfig,
} from "../../src/config.js";
import { listScripts, resolveScript } from "../../src/scripts/resolve.js";
import { scriptEnvironment } from "../../src/scripts/execute.js";
import {
  LEGACY_TOC_END,
  LEGACY_TOC_START,
  TOC_END,
  TOC_START,
  renderToc,
  synchronizeToc,
} from "../../src/toc.js";
import { parseSnippetLink, REGION_MARKER } from "../../src/snippets.js";
import {
  applyBaseline,
  BASELINE_FORMAT,
  LEGACY_BASELINE_FORMAT,
} from "../../src/audit-baseline.js";
import { isNotifierAllowed } from "../../src/update-notifier.js";
import type { ScriptDefinition, ScriptRegistry } from "../../src/scripts/registry.js";

/**
 * The compatibility layer left behind by the claude-cli → Cairn rename.
 *
 * Every identifier this tool writes into a user's files or environment kept its
 * pre-rename spelling as a *read* path. These cases are the contract for that:
 * they must keep passing for as long as the legacy spelling is accepted, and
 * deleting one is the deliberate act of dropping that compatibility.
 */

let root: string;

beforeEach(() => {
  // Realpathed because /tmp is a symlink on macOS and the script walk resolves
  // both sides of every containment check.
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cairn-legacy-")));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe("legacy configuration filename", () => {
  it("discovers .claude-cli.yml when no .cairn.yml exists", () => {
    const legacy = path.join(root, LEGACY_CONFIG_FILENAME);
    fs.writeFileSync(legacy, "version: 1\n");
    const nested = path.join(root, "a", "b");
    fs.mkdirSync(nested, { recursive: true });

    expect(findConfig(nested)).toBe(legacy);
    expect(loadConfig({ disabled: false }, nested).root).toBe(root);
  });

  it("prefers .cairn.yml when a directory holds both", () => {
    fs.writeFileSync(path.join(root, LEGACY_CONFIG_FILENAME), "version: 1\n");
    fs.writeFileSync(path.join(root, CONFIG_FILENAME), "version: 1\n");
    expect(configIn(root)).toBe(path.join(root, CONFIG_FILENAME));
  });

  it("prefers a nested legacy file over a current one further up", () => {
    fs.writeFileSync(path.join(root, CONFIG_FILENAME), "version: 1\n");
    const nested = path.join(root, "a");
    fs.mkdirSync(nested);
    const nestedLegacy = path.join(nested, LEGACY_CONFIG_FILENAME);
    fs.writeFileSync(nestedLegacy, "version: 1\n");
    expect(findConfig(nested)).toBe(nestedLegacy);
  });
});

describe("legacy script registry", () => {
  const body = "version: 1\nscripts:\n  greet:\n    run: echo hi\n";

  beforeEach(() => {
    execFileSync("git", ["init", "-q", root]);
  });

  it("resolves a script declared in a legacy registry", () => {
    fs.writeFileSync(path.join(root, LEGACY_CONFIG_FILENAME), body);
    const resolved = resolveScript("greet", { cwd: root });
    expect(resolved.winner?.registry.file).toBe(path.join(root, LEGACY_CONFIG_FILENAME));
  });

  it("counts a directory holding both filenames as one registry", () => {
    fs.writeFileSync(path.join(root, LEGACY_CONFIG_FILENAME), body);
    fs.writeFileSync(path.join(root, CONFIG_FILENAME), body);

    // The legacy file must not read as a second definition the current one
    // shadows — that would report a phantom conflict in `scripts which`.
    const resolved = resolveScript("greet", { cwd: root });
    expect(resolved.winner?.registry.file).toBe(path.join(root, CONFIG_FILENAME));
    expect(resolved.shadowed).toHaveLength(0);

    const listed = listScripts({ cwd: root });
    expect(listed.consulted).toHaveLength(1);
    expect(listed.scripts.map((entry) => entry.shadows)).toEqual([[]]);
  });
});

describe("legacy TOC markers", () => {
  const toc = renderToc([{ text: "Title", slug: "title", depth: 1, line: 1 }]);

  it("synchronizes a legacy marker pair", () => {
    const stale = synchronizeToc(`${LEGACY_TOC_START}\nold\n${LEGACY_TOC_END}\n`, toc);
    expect(stale.status).toBe("stale");
  });

  it("reports a current legacy pair as current, and preserves its spelling", () => {
    const document = `${LEGACY_TOC_START}\n${toc}\n${LEGACY_TOC_END}\n`;
    const result = synchronizeToc(document, toc);
    expect(result.status).toBe("current");

    // The markers themselves are never rewritten: migrating them would report
    // every legacy document as stale for a change that alters no table of
    // contents.
    if (result.status === "current") {
      expect(result.block).toContain(LEGACY_TOC_START);
      expect(result.block).not.toContain(TOC_START);
    }
  });

  it("rejects a pair that mixes the two spellings", () => {
    const mixed = synchronizeToc(`${TOC_START}\nold\n${LEGACY_TOC_END}\n`, toc);
    expect(mixed.status).toBe("malformed");
    const reversed = synchronizeToc(`${LEGACY_TOC_START}\nold\n${TOC_END}\n`, toc);
    expect(reversed.status).toBe("malformed");
  });
});

describe("legacy snippet syntax", () => {
  it("parses a legacy fence attribute", () => {
    const parsed = parseSnippetLink({ lang: "ts", meta: "claude-cli:snippet=src/a.ts#region" });
    expect(parsed.status).toBe("linked");
    if (parsed.status === "linked") {
      expect(parsed.targetPath).toBe("src/a.ts");
      expect(parsed.selector).toEqual({ kind: "region", name: "region" });
    }
  });

  it("matches a legacy region marker in a source file", () => {
    const match = REGION_MARKER.exec("// claude-cli:snippet:start region");
    expect(match?.[1]).toBe("start");
    expect(match?.[2]).toBe("region");
  });

  it("treats one fence carrying both spellings as a duplicate", () => {
    const parsed = parseSnippetLink({
      lang: "ts",
      meta: "cairn:snippet=a.ts claude-cli:snippet=b.ts",
    });
    expect(parsed.status).toBe("malformed");
    if (parsed.status === "malformed") expect(parsed.reason).toBe("duplicate-attribute");
  });

  it("still reports the missing-language failure for a legacy attribute", () => {
    const parsed = parseSnippetLink({ lang: "claude-cli:snippet=a.ts", meta: null });
    expect(parsed.status).toBe("malformed");
    if (parsed.status === "malformed") expect(parsed.reason).toBe("no-language");
  });
});

describe("legacy audit baseline", () => {
  // Findings carry absolute paths; the baseline stores them workspace-relative.
  const issue = () => ({
    file: path.join(root, "a.md"),
    line: 1,
    checker: "references",
    message: "broken",
  });

  it("accepts a legacy baselineFormat document", () => {
    const applied = applyBaseline(
      [issue()],
      {
        baselineFormat: LEGACY_BASELINE_FORMAT,
        version: "1",
        entries: [{ checker: "references", file: "a.md", message: "broken", count: 1 }],
      },
      root,
    );
    expect(applied.foreign).toBe(false);
    expect(applied.suppressed).toBe(1);
    expect(applied.kept).toHaveLength(0);
  });

  it("still rejects a document neither spelling wrote", () => {
    const applied = applyBaseline(
      [issue()],
      { baselineFormat: "something-else", version: "1" },
      root,
    );
    expect(applied.foreign).toBe(true);
  });

  it("writes the current discriminator", () => {
    expect(BASELINE_FORMAT).toBe("cairn-md-audit-baseline");
  });
});

describe("legacy environment variables", () => {
  const allowed = { argv: ["md", "lint"], isTty: true, format: "llm" as const };

  it("honors the pre-rename opt-out", () => {
    expect(isNotifierAllowed({ ...allowed, env: {} })).toBe(true);
    expect(isNotifierAllowed({ ...allowed, env: { CLAUDE_CLI_NO_UPDATE_NOTIFIER: "1" } })).toBe(
      false,
    );
    expect(isNotifierAllowed({ ...allowed, env: { CAIRN_NO_UPDATE_NOTIFIER: "1" } })).toBe(false);
  });

  it("exports both spellings to a script child", () => {
    const registry: ScriptRegistry = {
      file: path.join(root, CONFIG_FILENAME),
      directory: root,
      scripts: new Map(),
    };
    const definition = { name: "greet" } as ScriptDefinition;
    const env = scriptEnvironment({
      mode: "capture",
      definition,
      registry,
      workingDirectory: root,
      invokedFrom: root,
      args: [],
    });

    expect(env.CAIRN_SCRIPT_NAME).toBe("greet");
    expect(env.CLAUDE_CLI_SCRIPT_NAME).toBe("greet");
    expect(env.CAIRN_SCRIPT_ROOT).toBe(root);
    expect(env.CLAUDE_CLI_SCRIPT_ROOT).toBe(root);
    expect(env.CAIRN_SCRIPT_REGISTRY).toBe(registry.file);
    expect(env.CLAUDE_CLI_SCRIPT_REGISTRY).toBe(registry.file);
    expect(env.CAIRN_INVOKED_FROM).toBe(root);
    expect(env.CLAUDE_CLI_INVOKED_FROM).toBe(root);
    expect(env.CAIRN_NO_UPDATE_NOTIFIER).toBe("1");
    expect(env.CLAUDE_CLI_NO_UPDATE_NOTIFIER).toBe("1");
  });
});
