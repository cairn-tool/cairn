import { describe, expect, it } from "vitest";
import { evaluatePins } from "../../src/agent/verify/index.js";
import { verifyHasFindings } from "../../src/commands/agent-verify.js";
import { PROFILE_SCHEMA_VERSION } from "../../src/agent/targets/schema.js";
import { profileFor } from "../../src/agent/targets/index.js";
import { packageVersion } from "../../src/version.js";
import type { VerifyConfig } from "../../src/agent/verify/config.js";
import type { AgentDiagnostic } from "../../src/agent/types.js";

function config(pins: VerifyConfig["pins"]): VerifyConfig {
  return { file: "/repo/.cairn.yml", directory: "/repo", pins, entries: [] };
}

const diagnostic = (severity: AgentDiagnostic["severity"], code = "AB999"): AgentDiagnostic => ({
  code,
  severity,
  message: "test",
  quality: "exact",
});

describe("evaluatePins", () => {
  it("reports an omitted pin as unpinned, and still reports the actual value", () => {
    const { report, diagnostics } = evaluatePins(config({ targets: {} }), ["claude-code"]);
    expect(report.cli).toEqual({ declared: null, actual: packageVersion, status: "unpinned" });
    expect(report.profileSchemaVersion.status).toBe("unpinned");
    expect(report.profileSchemaVersion.actual).toBe(PROFILE_SCHEMA_VERSION);
    expect(report.targets[0]).toMatchObject({ target: "claude-code", status: "unpinned" });
    expect(diagnostics).toEqual([]);
  });

  it("satisfies a CLI range that contains the running build", () => {
    const { report, diagnostics } = evaluatePins(
      config({ cli: { min: "0.0.1" }, targets: {} }),
      [],
    );
    expect(report.cli.status).toBe("satisfied");
    expect(diagnostics).toEqual([]);
  });

  it("reports AB420 when the running build is outside the CLI pin", () => {
    const { report, diagnostics } = evaluatePins(
      config({ cli: { max: "0.0.1" }, targets: {} }),
      [],
    );
    expect(report.cli.status).toBe("violated");
    expect(diagnostics.map((item) => [item.code, item.severity])).toEqual([["AB420", "error"]]);
  });

  it("reports AB421 when the profile schema version disagrees", () => {
    const { diagnostics } = evaluatePins(config({ profileSchemaVersion: "99", targets: {} }), []);
    expect(diagnostics.map((item) => [item.code, item.severity])).toEqual([["AB421", "error"]]);
  });

  it("reports AB422 when a target's documentation revision is outside its pin", () => {
    const { diagnostics } = evaluatePins(
      config({ targets: { "claude-code": { min: "2099-01-01" } } }),
      ["claude-code"],
    );
    expect(diagnostics.map((item) => [item.code, item.target])).toEqual([["AB422", "claude-code"]]);
  });

  it("satisfies a documentation revision pin at the recorded value", () => {
    const actual = profileFor("claude-code").host.documentationRevision;
    const { report, diagnostics } = evaluatePins(
      config({ targets: { "claude-code": { exact: actual } } }),
      ["claude-code"],
    );
    expect(report.targets[0].status).toBe("satisfied");
    expect(diagnostics).toEqual([]);
  });

  it("evaluates only the targets the entries actually select", () => {
    const { report } = evaluatePins(config({ targets: {} }), ["codex"]);
    expect(report.targets.map((item) => item.target)).toEqual(["codex"]);
  });
});

describe("verifyHasFindings", () => {
  it("fails on an error", () => {
    expect(verifyHasFindings([diagnostic("error")], false)).toBe(true);
  });

  it("does not fail on a warning unless --strict", () => {
    expect(verifyHasFindings([diagnostic("warning")], false)).toBe(false);
    expect(verifyHasFindings([diagnostic("warning")], true)).toBe(true);
  });

  it("never fails on a notice, even under --strict", () => {
    expect(verifyHasFindings([diagnostic("notice", "AB426")], true)).toBe(false);
  });

  it("ignores mapping quality, so an approximate render does not fail a Codex entry", () => {
    const approximate: AgentDiagnostic = {
      code: "AB330",
      severity: "warning",
      message: "approximate",
      quality: "approximate",
    };
    expect(verifyHasFindings([approximate], false)).toBe(false);
  });
});
