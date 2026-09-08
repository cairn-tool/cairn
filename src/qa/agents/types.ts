import type { Usage } from "../outcome.js";

/**
 * Normalized harness event. Slot.applyEvent consumes only this; vendor JSON never
 * reaches the TUI, reports, or tracker.
 */
export type QaEvent =
  | {
      kind: "text";
      text: string;
      sessionId?: string;
    }
  | {
      kind: "thinking";
      phase: "delta" | "completed";
      text?: string;
      sessionId?: string;
    }
  | {
      kind: "tool";
      phase: "started" | "completed";
      name: string;
      summary: string;
      failed?: boolean;
      sessionId?: string;
    }
  | {
      kind: "usage";
      usage: Usage;
      error?: string;
      sessionId?: string;
    }
  | {
      kind: "init";
      model?: string;
      sessionId?: string;
    };

export type NormalizedEvents = QaEvent | QaEvent[] | null;

/** Enough of a case for argv construction without importing Case. */
export interface AgentArgvInput {
  repo: string;
  model: string;
  prompt: string;
}

/**
 * Per-backend profile. Registering another assistant is a new module plus a
 * line in index.ts. Nothing outside src/qa/agents/ may branch on an agent's name.
 */
export interface QaAgentProfile {
  readonly name: string;
  /** PATH candidates, first match wins. */
  readonly binaries: readonly string[];
  readonly defaultModel: string;
  /**
   * A real concurrency limit for this backend, or absent when the vendor imposes none we
   * know of. Combined with --parallel by min(), so an absent cap means --parallel alone
   * decides. Never set this to the *default* of --parallel: that silently caps the flag.
   * Must be >= 1 when present.
   */
  readonly maxParallel?: number;
  buildArgv(input: AgentArgvInput, binary: string): string[];
  normalize(raw: Record<string, unknown>): NormalizedEvents;
}

export function asEventList(events: NormalizedEvents): QaEvent[] {
  if (events === null) return [];
  if (Array.isArray(events)) return [...events];
  return [events];
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function sessionIdOf(raw: Record<string, unknown>): string | undefined {
  const value = raw["session_id"];
  return value ? String(value) : undefined;
}

export function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
