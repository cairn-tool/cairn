import { describe, it, expect } from "vitest";
import {
  doctorHasFindings,
  hostVersionStatus,
  parseHostVersions,
} from "../../src/commands/agent-doctor.js";
import type { AgentDiagnostic } from "../../src/agent/types.js";
import type { HostProfile } from "../../src/agent/targets/index.js";
import { TARGET_PROFILES } from "../../src/agent/targets/index.js";

const diagnostic = (severity: AgentDiagnostic["severity"]): AgentDiagnostic => ({
  code: "AB999",
  severity,
  message: "test",
  quality: "exact",
});

describe("parseHostVersions", () => {
  it("accepts target-qualified versions", () => {
    const versions = parseHostVersions(["codex@1.2.3", "cursor@2.0.0"], ["codex", "cursor"]);
    expect(versions.get("codex")).toBe("1.2.3");
    expect(versions.get("cursor")).toBe("2.0.0");
  });

  it("accepts a bare version when exactly one target is selected", () => {
    expect(parseHostVersions(["1.2.3"], ["codex"]).get("codex")).toBe("1.2.3");
  });

  it("rejects a bare version when the target is ambiguous", () => {
    expect(() => parseHostVersions(["1.2.3"], ["codex", "cursor"])).toThrow(/needs a target/);
  });

  it("rejects an unknown target", () => {
    expect(() => parseHostVersions(["borg@1.0.0"], ["codex"])).toThrow(/Unknown target/);
  });

  it("rejects a malformed version", () => {
    expect(() => parseHostVersions(["codex@latest"], ["codex"])).toThrow(/Invalid version/);
    expect(() => parseHostVersions(["codex@"], ["codex"])).toThrow(/Invalid version/);
  });

  it("returns an empty map when no versions are supplied", () => {
    expect(parseHostVersions(undefined, ["codex"]).size).toBe(0);
  });
});

describe("hostVersionStatus", () => {
  // The shipped profiles record no bounds yet, so the comparison branches are
  // exercised against a synthetic host rather than a real target.
  const bounded: HostProfile = {
    displayName: "Test host",
    documentationRevision: "2026-01-01",
    minimumVersion: "1.5.0",
    verifiedThrough: "2.4.0",
    versionCommand: null,
    nativeValidator: null,
  };

  it("reports unknown when no version is supplied", () => {
    expect(hostVersionStatus(bounded, null)).toBe("unknown");
  });

  it("reports unverified when the profile records no bounds", () => {
    const unbounded = { ...bounded, minimumVersion: null, verifiedThrough: null };
    expect(hostVersionStatus(unbounded, "9.9.9")).toBe("unverified");
  });

  it("classifies versions against the recorded bounds", () => {
    expect(hostVersionStatus(bounded, "1.4.9")).toBe("below-minimum");
    expect(hostVersionStatus(bounded, "1.5.0")).toBe("verified");
    expect(hostVersionStatus(bounded, "2.0.0")).toBe("verified");
    expect(hostVersionStatus(bounded, "2.4.0")).toBe("verified");
    expect(hostVersionStatus(bounded, "2.4.1")).toBe("newer");
  });

  it("keeps every shipped target useful with no version data", () => {
    for (const profile of Object.values(TARGET_PROFILES)) {
      // An unknown host version is never a finding, whatever the profile records.
      expect(hostVersionStatus(profile.host, null)).toBe("unknown");
      // A profile that records no bounds cannot classify anything, and must
      // still report `unverified` rather than a confident answer.
      if (profile.host.minimumVersion === null && profile.host.verifiedThrough === null)
        expect(hostVersionStatus(profile.host, "1.0.0")).toBe("unverified");
    }
  });

  it("uses the bounds a profile does record", () => {
    // Antigravity is the first shipped profile written against a known host
    // version, so it is the one that exercises this path for real.
    const antigravity = TARGET_PROFILES.antigravity.host;
    expect(antigravity.verifiedThrough).toBe("1.1.18");
    expect(hostVersionStatus(antigravity, "1.1.18")).toBe("verified");
    expect(hostVersionStatus(antigravity, "1.2.0")).toBe("newer");
  });
});

describe("doctorHasFindings", () => {
  it("fails on an error at any strictness", () => {
    expect(doctorHasFindings([diagnostic("error")], false)).toBe(true);
    expect(doctorHasFindings([diagnostic("error")], true)).toBe(true);
  });

  it("fails on a warning only under --strict", () => {
    expect(doctorHasFindings([diagnostic("warning")], false)).toBe(false);
    expect(doctorHasFindings([diagnostic("warning")], true)).toBe(true);
  });

  it("never fails on a notice", () => {
    expect(doctorHasFindings([diagnostic("notice")], true)).toBe(false);
  });

  it("ignores mapping quality, unlike the shared findings rule", () => {
    // The shared rule treats any approximate mapping as a failure without
    // --strict, which would make every codex bundle a doctor failure.
    const approximate: AgentDiagnostic = {
      code: "AB332",
      severity: "warning",
      message: "approximate mapping",
      quality: "approximate",
    };
    expect(doctorHasFindings([approximate], false)).toBe(false);
  });
});
