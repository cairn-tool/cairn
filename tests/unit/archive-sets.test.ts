import { describe, expect, it } from "vitest";
import {
  ARCHIVE_PROFILES,
  ARTIFACT_CLASSES,
  DEFAULT_CLASSES,
  parseClasses,
  profileFor,
} from "../../src/archive/sets.js";
import { PROVIDERS } from "../../src/usage/providers/index.js";

/**
 * What the archive selects, and what it deliberately does not.
 *
 * The exclusions matter more than the inclusions here. `~/.claude` alone holds
 * hundreds of megabytes of plugin payloads and build scratch, none of it
 * conversation data, so these cases pin that the sets are an allowlist of
 * directories rather than a sweep with a blocklist bolted on.
 */

function matcher(provider: string, id: string) {
  const set = profileFor(provider)!.sets.find((candidate) => candidate.id === id);
  expect(set, `${provider} has no set ${id}`).toBeDefined();
  return set!;
}

describe("artifact sets", () => {
  it("names a registered usage provider, which is what resolves the log root", () => {
    const known = new Set(PROVIDERS.map((provider) => provider.name));
    for (const profile of ARCHIVE_PROFILES) expect(known).toContain(profile.provider);
  });

  it("declares only known classes", () => {
    for (const profile of ARCHIVE_PROFILES) {
      for (const set of profile.sets) expect(ARTIFACT_CLASSES).toContain(set.class);
    }
  });

  it("keeps transcripts and logs out of the default run", () => {
    // The same corpus is roughly 150 MB of plans and artifacts, and over 9 GB
    // once transcripts are included; making that the default would be a trap.
    expect([...DEFAULT_CLASSES]).toEqual(["plan", "artifact"]);
  });

  describe("claude-code", () => {
    it("finds tool results at the depth they really live at", () => {
      // Seven components deep on a real corpus, which is deeper than the usage
      // provider's own walk — it descends only into `subagents/`.
      const set = matcher("claude-code", "tool-results");
      expect(set.match("slug/session-uuid/tool-results/webfetch-1787.pdf")).toBe(true);
      expect(set.match("slug/session-uuid/tool-results/pdf-abc/page-15.jpg")).toBe(true);
      expect(set.match("slug/session-uuid.jsonl")).toBe(false);
    });

    it("takes memory files but not every markdown under projects", () => {
      const set = matcher("claude-code", "memory");
      expect(set.match("slug/memory/MEMORY.md")).toBe(true);
      expect(set.match("slug/memory/feedback_commit_style.md")).toBe(true);
      expect(set.match("slug/notes.md")).toBe(false);
      expect(set.match("slug/memory/notes.txt")).toBe(false);
    });

    it("takes both transcript shapes and the subagent metadata beside them", () => {
      const set = matcher("claude-code", "transcripts");
      expect(set.match("slug/session.jsonl")).toBe(true);
      expect(set.match("slug/session/subagents/agent-1.jsonl")).toBe(true);
      expect(set.match("slug/session/subagents/agent-1.meta.json")).toBe(true);
      // A `.meta.json` that is not a subagent's is somebody else's index file.
      expect(set.match("slug/.session_cache.json")).toBe(false);
    });

    it("never names the directories that would dominate an archive", () => {
      // plugins, downloads, backups, file-history and jobs: re-downloadable or
      // derived, and `jobs/` on a real machine was 343 MB of compiler output.
      const roots = profileFor("claude-code")!.sets.map((set) => set.root);
      for (const excluded of ["plugins", "downloads", "backups", "file-history", "jobs"]) {
        expect(roots).not.toContain(excluded);
      }
    });
  });

  describe("antigravity", () => {
    it("tells a session's output from the machinery beside it", () => {
      // One directory name is the whole distinction, which is why the sets test
      // for it rather than listing filenames.
      const plans = matcher("antigravity", "plans");
      expect(plans.match("7df59738/implementation_plan.md")).toBe(true);
      expect(plans.match("7df59738/walkthrough.md")).toBe(true);
      expect(plans.match("7df59738/.system_generated/logs/transcript.jsonl")).toBe(false);

      const outputs = matcher("antigravity", "outputs");
      expect(outputs.match("ac843a3e/scratch/pole_placement.py")).toBe(true);
      expect(outputs.match("ac843a3e/notes.md")).toBe(false); // that is a plan
      expect(outputs.match("ac843a3e/.system_generated/messages/x.json")).toBe(false);
    });

    it("takes the truncated transcript, not the full one", () => {
      // They share a schema and differ only in whether long strings are cut, so
      // archiving both would store the same conversation twice.
      const set = matcher("antigravity", "transcripts");
      expect(set.match("id/.system_generated/logs/transcript.jsonl")).toBe(true);
      expect(set.match("id/.system_generated/logs/transcript_full.jsonl")).toBe(false);
    });

    it("marks the live conversation databases for a consistent snapshot", () => {
      const set = matcher("antigravity", "conversations");
      expect(set.snapshot).toBe("sqlite");
      expect(set.match("abc.db")).toBe(true);
      // The sidecars are folded into the snapshot, never archived beside it.
      expect(set.match("abc.db-wal")).toBe(false);
      expect(set.match("abc.db-shm")).toBe(false);
    });
  });

  describe("codex", () => {
    it("has no plans, because Codex writes none", () => {
      expect(profileFor("codex")!.sets.some((set) => set.class === "plan")).toBe(false);
    });

    it("marks its live databases for a consistent snapshot", () => {
      const set = matcher("codex", "databases");
      expect(set.snapshot).toBe("sqlite");
      expect(set.match("thread_history_1.sqlite")).toBe(true);
      expect(set.match("history.jsonl")).toBe(false);
    });

    it("takes rollouts, and only rollouts, from sessions", () => {
      const set = matcher("codex", "transcripts");
      expect(set.match("2026/08/22/rollout-2026-08-22T12-23-48-01a02a80.jsonl")).toBe(true);
      expect(set.match("2026/08/22/notes.jsonl")).toBe(false);
    });
  });

  describe("gemini-cli", () => {
    it("never sweeps the helper binaries that sit beside the projects", () => {
      // ~/.gemini/tmp/bin/rg is 3.2 MB of downloaded ripgrep. Every matcher
      // requires a named directory segment so that nothing here can match.
      for (const set of profileFor("gemini-cli")!.sets) {
        expect(set.match("bin/rg")).toBe(false);
      }
    });

    it("tells a plan from a tool output from a transcript", () => {
      expect(matcher("gemini-cli", "plans").match("alpha/session-uuid/plans/design.md")).toBe(true);
      expect(matcher("gemini-cli", "plans").match("alpha/chats/session-x.jsonl")).toBe(false);
      expect(
        matcher("gemini-cli", "tool-outputs").match("alpha/tool-outputs/session-u/read_1.txt"),
      ).toBe(true);
      expect(
        matcher("gemini-cli", "transcripts").match("alpha/chats/parent-uuid/ab12cd.jsonl"),
      ).toBe(true);
    });

    it("takes the project history and not a logs.json written deeper", () => {
      const set = matcher("gemini-cli", "history");
      expect(set.match("alpha/logs.json")).toBe(true);
      expect(set.match("alpha/chats/parent-uuid/logs.json")).toBe(false);
    });
  });

  describe("opencode", () => {
    it("has no plans, because OpenCode writes none", () => {
      expect(profileFor("opencode")!.sets.some((set) => set.class === "plan")).toBe(false);
    });

    it("marks the live session store for a snapshot and leaves its sidecars alone", () => {
      const set = matcher("opencode", "database");
      expect(set.snapshot).toBe("sqlite");
      expect(set.match("opencode.db")).toBe(true);
      expect(set.match("opencode.db-wal")).toBe(false);
      expect(set.match("opencode.db-shm")).toBe(false);
    });

    it("keeps the git snapshot store out of a default run", () => {
      // It mirrors the working tree rather than being session output, which is
      // the same reason Claude Code's file-history is excluded outright.
      expect(matcher("opencode", "snapshots").class).toBe("log");
    });

    it("takes per-session diffs as artifacts", () => {
      expect(matcher("opencode", "session-diffs").match("session_diff/ses_1.json")).toBe(true);
      expect(matcher("opencode", "session-diffs").match("session_diff/notes.txt")).toBe(false);
    });
  });
});

describe("parseClasses", () => {
  it("defaults to plans and artifacts", () => {
    expect(parseClasses(undefined)).toEqual(["plan", "artifact"]);
  });

  it("accepts singular and plural, because both spellings appear in the output", () => {
    expect(parseClasses("plans,logs")).toEqual(["plan", "log"]);
    expect(parseClasses("plan,log")).toEqual(["plan", "log"]);
    expect(parseClasses("PLANS")).toEqual(["plan"]);
  });

  it("returns classes in a fixed order however they were given", () => {
    expect(parseClasses("logs,plans")).toEqual(["plan", "log"]);
  });

  it("deduplicates", () => {
    expect(parseClasses("plans,plan,plans")).toEqual(["plan"]);
  });

  it("rejects an unknown class rather than silently archiving nothing", () => {
    expect(() => parseClasses("everything")).toThrow(/Invalid --include/);
    expect(() => parseClasses("")).toThrow(/at least one/);
  });
});
