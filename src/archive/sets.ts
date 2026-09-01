/**
 * What each provider leaves on disk that is worth keeping.
 *
 * This is data the archiver reads, exactly as `src/agent/targets/*.ts` is for
 * the renderer and `ProviderCapabilities` is for the usage reports.
 * `src/commands/archive.ts` must never branch on a provider name: a provider
 * that stores plans somewhere unusual says so here, and adding a fourth
 * assistant is a new entry in this list plus the usage provider it names.
 *
 * Selection is an **allowlist of directories**, not a filter over a whole home
 * directory, and that is the design. `~/.claude` alone holds 340 MB of plugin
 * payloads, a 71 MB downloaded binary, and a `jobs/` tree that on this machine
 * was 343 MB of Rust build output — none of it conversation data, all of it
 * things a blocklist would eventually fail to exclude. Walking only what is
 * named here cannot pick them up by accident.
 */

import fs from "node:fs";
import path from "node:path";
import type { ProviderEnvironment } from "../usage/providers/types.js";

/**
 * What an artifact is, which is what `--include` selects on.
 *
 * `plan` and `artifact` are archived by default: they are the durable output of
 * a session, they are small, and nothing else keeps them. `transcript` and `log`
 * are opt-in because they are the other three orders of magnitude — the same
 * corpus is roughly 150 MB of the first two and over 9 GB with the rest.
 */
export type ArtifactClass = "plan" | "artifact" | "transcript" | "log";

export const ARTIFACT_CLASSES: readonly ArtifactClass[] = ["plan", "artifact", "transcript", "log"];

/** The classes `archive run` takes when `--include` is not given. */
export const DEFAULT_CLASSES: readonly ArtifactClass[] = ["plan", "artifact"];

export interface ArtifactSet {
  /** Stable identifier, reported per set so a caller can see what matched. */
  id: string;
  class: ArtifactClass;
  description: string;
  /**
   * Which of the provider's trees {@link root} is relative to.
   *
   * Absent means the provider's own log root, which is every set but Cursor's.
   * `"alt"` means the profile's {@link ArchiveProfile.altRoot}, for a host that
   * genuinely keeps its conversation data and its session output in two
   * different places; see the note on {@link CURSOR}.
   */
  tree?: "alt";
  /** Directory under the selected tree to walk; "" is the tree root itself. */
  root: string;
  /** Whether to descend into subdirectories. */
  recursive: boolean;
  /** Decides membership, given a path relative to {@link root}, POSIX-separated. */
  match(relative: string): boolean;
  /**
   * How to read a file whose bytes are not safe to copy directly.
   *
   * Every Codex `.sqlite` and all 501 Antigravity `.db` files carry live `-wal`
   * sidecars, so copying the main file alone can capture a torn page image.
   * `sqlite` routes them through the online backup API, which produces a
   * consistent snapshot of a database being written to.
   */
  snapshot?: "sqlite";
}

export interface ArchiveProfile {
  /** Matches a `UsageProvider.name`, which is what resolves the log root. */
  provider: string;
  sets: readonly ArtifactSet[];
  /**
   * A second tree this host keeps things in, for sets marked `tree: "alt"`.
   *
   * Every other provider needs exactly one root, because the usage provider's
   * log root already contains everything worth archiving. Cursor does not: it is
   * an editor, so its conversation store sits in the Electron user-data
   * directory while its plans and per-session output sit in `~/.cursor`. On
   * macOS those two share only `$HOME`, and rooting a set at `$HOME` is the
   * home-directory sweep this module exists to avoid, so the profile names the
   * second tree explicitly instead.
   *
   * Returns null when the tree is absent, in which case its sets contribute
   * nothing rather than falling back to the primary root.
   */
  altRoot?(context: ProviderEnvironment): string | null;
}

const isMarkdown = (relative: string): boolean => relative.endsWith(".md");
const segments = (relative: string): string[] => relative.split("/");
const under = (relative: string, directory: string): boolean =>
  segments(relative).includes(directory);

/**
 * Claude Code, under `~/.claude`.
 *
 * Note what is *not* here: `plugins/`, `downloads/`, `backups/`, `file-history/`
 * and `jobs/`. The first four are re-downloadable or derived, and `jobs/` is a
 * scratch tree for background work that on a real machine is dominated by
 * compiler output.
 */
const CLAUDE_CODE: ArchiveProfile = {
  provider: "claude-code",
  sets: [
    {
      id: "plans",
      class: "plan",
      description: "Plan documents written in plan mode",
      root: "plans",
      recursive: false,
      match: isMarkdown,
    },
    {
      id: "tool-results",
      class: "artifact",
      description: "Files tools produced: fetched PDFs, rendered pages, saved output",
      root: "projects",
      // Depth seven on a real corpus, which is deeper than the usage provider's
      // own discovery walks — it descends only into `subagents/`.
      recursive: true,
      match: (relative) => under(relative, "tool-results"),
    },
    {
      id: "memory",
      class: "artifact",
      description: "Per-project memory files",
      root: "projects",
      recursive: true,
      match: (relative) => under(relative, "memory") && isMarkdown(relative),
    },
    {
      id: "transcripts",
      class: "transcript",
      description: "Session and subagent transcripts",
      root: "projects",
      recursive: true,
      match: (relative) =>
        relative.endsWith(".jsonl") ||
        (relative.endsWith(".meta.json") && segments(relative).at(-1)!.startsWith("agent-")),
    },
    {
      id: "history",
      class: "log",
      description: "Prompt history and the daemon log",
      root: "",
      recursive: false,
      match: (relative) => relative === "history.jsonl" || relative === "daemon.log",
    },
    {
      id: "shell-snapshots",
      class: "log",
      description: "Captured shell environments",
      root: "shell-snapshots",
      recursive: false,
      match: (relative) => relative.endsWith(".sh"),
    },
  ],
};

/** Codex, under `~/.codex`. Codex writes no plans. */
const CODEX: ArchiveProfile = {
  provider: "codex",
  sets: [
    {
      id: "computer-use",
      class: "artifact",
      description: "Screenshots and captures from computer-use sessions",
      root: "computer-use",
      recursive: true,
      match: () => true,
    },
    {
      id: "transcripts",
      class: "transcript",
      description: "Rollout transcripts",
      root: "sessions",
      recursive: true,
      match: (relative) =>
        segments(relative).at(-1)!.startsWith("rollout-") && relative.endsWith(".jsonl"),
    },
    {
      id: "history",
      class: "log",
      description: "Prompt history",
      root: "",
      recursive: false,
      match: (relative) => relative === "history.jsonl",
    },
    {
      id: "databases",
      class: "log",
      description: "Thread history and log databases",
      root: "",
      recursive: false,
      match: (relative) => relative.endsWith(".sqlite"),
      snapshot: "sqlite",
    },
  ],
};

/**
 * Antigravity, under `~/.gemini/antigravity-cli`.
 *
 * A conversation's `brain/<id>/` holds `.system_generated/` — the machinery — and,
 * at its top level, whatever the session actually produced:
 * `implementation_plan.md`, `walkthrough.md`, `task.md`, generated scripts. The
 * two are told apart by that one directory name, which is why every set here
 * tests for it rather than listing filenames.
 */
const ANTIGRAVITY: ArchiveProfile = {
  provider: "antigravity",
  sets: [
    {
      id: "plans",
      class: "plan",
      description: "Implementation plans, walkthroughs, and task notes",
      root: "brain",
      recursive: true,
      match: (relative) => !under(relative, ".system_generated") && isMarkdown(relative),
    },
    {
      id: "outputs",
      class: "artifact",
      description: "Other files a conversation produced",
      root: "brain",
      recursive: true,
      match: (relative) => !under(relative, ".system_generated") && !isMarkdown(relative),
    },
    {
      id: "transcripts",
      class: "transcript",
      description: "Conversation transcripts",
      root: "brain",
      recursive: true,
      // `transcript_full.jsonl` shares this schema and differs only in whether
      // long strings are truncated, so archiving both would store the same
      // conversation twice for no extra structural fact.
      match: (relative) => relative.endsWith("/logs/transcript.jsonl"),
    },
    {
      id: "history",
      class: "log",
      description: "Prompt history",
      root: "",
      recursive: false,
      match: (relative) => relative === "history.jsonl",
    },
    {
      id: "logs",
      class: "log",
      description: "CLI logs",
      root: "log",
      recursive: false,
      match: (relative) => relative.endsWith(".log"),
    },
    {
      id: "conversations",
      class: "log",
      description: "Conversation databases",
      root: "conversations",
      recursive: false,
      // `-wal` and `-shm` are the live sidecars of the file next to them; the
      // backup API folds their contents into the snapshot it produces.
      match: (relative) => relative.endsWith(".db"),
      snapshot: "sqlite",
    },
  ],
};

/**
 * Gemini CLI, under `~/.gemini`.
 *
 * Every set is rooted at `tmp`, and that confinement is the point. `~/.gemini`
 * is a shared tree: `antigravity-cli/` belongs to the other provider rooted
 * here and would otherwise be archived twice, `antigravity/` is the IDE's store
 * and is encrypted at rest, and `oauth_creds.json` is a credential. None of
 * them is reachable from `tmp`.
 *
 * There is deliberately no catch-all under `tmp` either: the CLI downloads
 * helper binaries into `tmp/bin/` — a 3.2 MB `rg` on this machine — beside the
 * projects. Every matcher below requires a named directory segment, so nothing
 * that is not conversation data can match one.
 */
const GEMINI_CLI: ArchiveProfile = {
  provider: "gemini-cli",
  sets: [
    {
      id: "plans",
      class: "plan",
      description: "Plan documents",
      root: "tmp",
      recursive: true,
      // <slug>/<session uuid>/plans/<name>.md — the directory name is the whole
      // distinction, exactly as `.system_generated` is for Antigravity.
      match: (relative) => under(relative, "plans") && isMarkdown(relative),
    },
    {
      id: "tool-outputs",
      class: "artifact",
      description: "Captured tool output",
      root: "tmp",
      recursive: true,
      match: (relative) => under(relative, "tool-outputs"),
    },
    {
      id: "transcripts",
      class: "transcript",
      description: "Session and subagent chat transcripts",
      root: "tmp",
      recursive: true,
      match: (relative) => under(relative, "chats") && relative.endsWith(".jsonl"),
    },
    {
      id: "history",
      class: "log",
      description: "Prompt and slash-command history",
      root: "tmp",
      recursive: true,
      // Depth-checked rather than matched on the basename, so that a `logs.json`
      // written deeper in a project cannot be swept in as project history.
      match: (relative) => segments(relative).length === 2 && segments(relative)[1] === "logs.json",
    },
  ],
};

/**
 * OpenCode, under `$XDG_DATA_HOME/opencode` (default `~/.local/share/opencode`).
 *
 * The first provider whose entire transcript corpus lives inside a single
 * `log`-class file: there is no per-session transcript to select, because the
 * conversations are rows in `opencode.db`. Archiving the database archives them
 * all, which is why that set is opt-in like every other transcript source.
 */
const OPENCODE: ArchiveProfile = {
  provider: "opencode",
  sets: [
    {
      id: "session-diffs",
      class: "artifact",
      description: "Per-session file diffs",
      root: "storage",
      recursive: true,
      match: (relative) => relative.endsWith(".json"),
    },
    {
      id: "logs",
      class: "log",
      description: "CLI logs",
      root: "log",
      recursive: false,
      match: (relative) => relative.endsWith(".log"),
    },
    {
      id: "snapshots",
      class: "log",
      description: "Bare git repositories holding pre-edit file snapshots",
      root: "snapshot",
      recursive: true,
      // Class `log` rather than `artifact`: this is an object store mirroring
      // the working tree, the same category as Claude Code's `file-history/`,
      // which is excluded outright. It is the only record of pre-edit state, so
      // it is kept — but it must never land in a default run.
      match: () => true,
    },
    {
      id: "database",
      class: "log",
      description: "The session store: sessions, messages, parts, and projects",
      root: "",
      recursive: false,
      // Exact equality, so the live `-wal` and `-shm` sidecars are never matched
      // on their own; the backup API folds their contents into the snapshot.
      match: (relative) => relative === "opencode.db",
      snapshot: "sqlite",
    },
  ],
};

/**
 * Cursor, whose data is in two trees.
 *
 * The usage provider roots at the Electron user-data directory, because that is
 * where the conversation store is. But Cursor writes its plans, its agent
 * transcripts and its per-session output under `~/.cursor` instead, so those
 * sets are marked `tree: "alt"`. This is the only profile that needs a second
 * anchor, and the reason is on `ArchiveProfile.altRoot`.
 *
 * What is *not* here is most of both trees, and the exclusions carry more weight
 * than usual because this is an editor rather than a CLI: `extensions/` alone is
 * 3.8 GB, and `CachedData/`, `Partitions/`, `WebStorage/`, `Cache/`, `GPUCache/`
 * and `blob_storage/` are another 600 MB of derived state. `User/History/` is
 * excluded too -- it is VS Code's local file history, which mirrors the working
 * tree rather than recording a session, the same category as Claude Code's
 * `file-history/`. Every matcher below names a directory or a filename, so none
 * of that is reachable.
 */
const CURSOR: ArchiveProfile = {
  provider: "cursor",
  altRoot: (context) => {
    const candidate = path.join(context.home, ".cursor");
    try {
      return fs.statSync(candidate).isDirectory() ? candidate : null;
    } catch {
      return null;
    }
  },
  sets: [
    {
      id: "plans",
      class: "plan",
      description: "Plan documents written in plan mode",
      tree: "alt",
      root: "plans",
      recursive: false,
      match: (relative) => relative.endsWith(".plan.md"),
    },
    {
      id: "project-assets",
      class: "artifact",
      description: "Files a session produced: canvases, uploads, and assets",
      tree: "alt",
      root: "projects",
      recursive: true,
      // Three named directory segments rather than a catch-all: `projects/`
      // also holds `terminals/`, `mcps/` and the transcripts, and a sweep here
      // would take the whole 64 MB tree twice over.
      match: (relative) =>
        under(relative, "canvases") || under(relative, "uploads") || under(relative, "assets"),
    },
    {
      id: "transcripts",
      class: "transcript",
      description: "Agent transcripts",
      tree: "alt",
      root: "projects",
      recursive: true,
      match: (relative) => under(relative, "agent-transcripts") && relative.endsWith(".jsonl"),
    },
    {
      id: "ai-tracking",
      class: "log",
      description: "The AI code-attribution database: per-model line counts and scored commits",
      tree: "alt",
      root: "ai-tracking",
      recursive: false,
      match: (relative) => relative === "ai-code-tracking.db",
      snapshot: "sqlite",
    },
    {
      id: "hooks",
      class: "log",
      description: "Hook configuration",
      tree: "alt",
      root: "",
      recursive: false,
      match: (relative) => relative === "hooks.json",
    },
    {
      id: "conversations",
      class: "log",
      description: "The editor store: conversations, turns, and the session index",
      root: path.join("User", "globalStorage"),
      recursive: false,
      // Exact equality, three times load-bearing. It keeps out the live `-wal`
      // and `-shm` sidecars, whose contents the backup API folds into the
      // snapshot; and it keeps out `state.vscdb.backup`, which on a real machine
      // is a stale 3.4 GB copy months out of date.
      match: (relative) => relative === "state.vscdb",
      snapshot: "sqlite",
    },
    {
      id: "workspace-state",
      class: "log",
      description: "Per-workspace state, holding the legacy inline-edit prompt history",
      root: path.join("User", "workspaceStorage"),
      recursive: true,
      // Depth-checked, so only the store directly under a workspace directory
      // matches and nothing deeper can be swept in.
      match: (relative) =>
        segments(relative).length === 2 && segments(relative)[1] === "state.vscdb",
      snapshot: "sqlite",
    },
  ],
};

export const ARCHIVE_PROFILES: readonly ArchiveProfile[] = [
  CLAUDE_CODE,
  CODEX,
  ANTIGRAVITY,
  GEMINI_CLI,
  OPENCODE,
  CURSOR,
];

export function profileFor(provider: string): ArchiveProfile | undefined {
  return ARCHIVE_PROFILES.find((profile) => profile.provider === provider);
}

/** Parses `--include plans,transcripts` into the classes it names. */
export function parseClasses(value: string | undefined): ArtifactClass[] {
  if (value === undefined) return [...DEFAULT_CLASSES];
  const names = value
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  if (names.length === 0) throw new Error("--include needs at least one class");

  // Plural spellings are what the classes are called on the command line, and
  // singular is what a row reports, so both are accepted rather than making the
  // caller remember which surface they are on.
  const aliases: Record<string, ArtifactClass> = {
    plan: "plan",
    plans: "plan",
    artifact: "artifact",
    artifacts: "artifact",
    transcript: "transcript",
    transcripts: "transcript",
    log: "log",
    logs: "log",
  };
  const chosen = new Set<ArtifactClass>();
  for (const name of names) {
    const resolved = aliases[name.toLowerCase()];
    if (!resolved) {
      throw new Error(
        `Invalid --include value: ${name} (expected ${ARTIFACT_CLASSES.map((c) => `${c}s`).join(", ")})`,
      );
    }
    chosen.add(resolved);
  }
  return ARTIFACT_CLASSES.filter((name) => chosen.has(name));
}
