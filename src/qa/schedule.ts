import type { Case } from "./cases.js";

/**
 * The work queue plus the per-case concurrency constraints.
 *
 * A `parallel: true` case is unconstrained (except by the per-backend cap). A
 * `parallel: false` case with tags holds each of those tags as a mutex while it
 * runs. A `parallel: false` case with no tags is a barrier: nothing runs beside
 * it, and nothing behind it starts while it waits for the agents in front to finish.
 *
 * Invariant: with `running === 0` and a non-empty queue this never returns null —
 * no tag can be held, an exclusive case is startable, and a per-backend cap is
 * skipped when the queue is idle so a cap can never deadlock an idle queue.
 */
export class Scheduler {
  private readonly pending: Case[];
  private readonly heldTags = new Set<string>();
  private readonly caps: ReadonlyMap<string, number>;
  private readonly agentRunning = new Map<string, number>();
  private running = 0;
  private exclusive: Case | null = null;
  private waiters: Array<() => void> = [];
  /** Bumped by every wake. A worker samples it before `take()` so a wake cannot be lost. */
  private generation = 0;
  /** Set by `take()` when it returns null, so the TUI can say why nothing is starting. */
  private blocked: string | null = null;

  constructor(cases: readonly Case[], caps: ReadonlyMap<string, number> = new Map()) {
    this.pending = [...cases];
    this.caps = caps;
  }

  /** Cases not yet dispatched. */
  get size(): number {
    return this.pending.length;
  }

  get inFlight(): number {
    return this.running;
  }

  /** Sample before `take()`; hand back to `changed()` so a wake in between is not missed. */
  get generationId(): number {
    return this.generation;
  }

  private capFor(kase: Case): number {
    return this.caps.get(kase.agentName) ?? Number.POSITIVE_INFINITY;
  }

  private atCap(kase: Case): boolean {
    return (this.agentRunning.get(kase.agentName) ?? 0) >= this.capFor(kase);
  }

  /**
   * The first case that may start right now, with its tags reserved. Null when the queue is empty
   * or every startable candidate is blocked.
   *
   * Invariant: with `running === 0` and a non-empty queue this never returns null — no tag can be
   * held and an exclusive case is startable — so a queue can never stall with nothing in flight.
   */
  take(): Case | null {
    if (this.pending.length === 0) {
      this.blocked = null;
      return null;
    }
    if (this.exclusive !== null) {
      this.blocked = `${this.exclusive.name} is running alone`;
      return null;
    }

    const waitingOn = new Set<string>();
    const waitingAgents = new Set<string>();
    for (const [i, kase] of this.pending.entries()) {
      if (this.atCap(kase) && this.running > 0) {
        waitingAgents.add(kase.agentName);
        continue;
      }

      if (kase.parallel) return this.claim(i, kase);

      if (kase.tags.length === 0) {
        if (this.running === 0) return this.claim(i, kase);
        // A barrier: hold everything behind it rather than starving it.
        this.blocked = `waiting for ${this.running} agent(s) to finish before ${kase.name}`;
        return null;
      }

      const clash = kase.tags.filter((t) => this.heldTags.has(t));
      if (clash.length === 0) return this.claim(i, kase);
      for (const tag of clash) waitingOn.add(tag);
    }

    if (waitingAgents.size > 0) {
      this.blocked = `waiting on agent cap: ${[...waitingAgents].sort().join(", ")}`;
      return null;
    }
    this.blocked =
      waitingOn.size > 0 ? `waiting on tag: ${[...waitingOn].sort().join(", ")}` : null;
    return null;
  }

  private claim(index: number, kase: Case): Case {
    this.pending.splice(index, 1);
    this.running += 1;
    this.agentRunning.set(kase.agentName, (this.agentRunning.get(kase.agentName) ?? 0) + 1);
    this.blocked = null;
    if (kase.parallel) return kase;
    if (kase.tags.length === 0) this.exclusive = kase;
    else for (const tag of kase.tags) this.heldTags.add(tag);
    return kase;
  }

  /** Give back whatever `take()` reserved, then wake every parked worker to re-scan. */
  release(kase: Case): void {
    this.running = Math.max(0, this.running - 1);
    const held = (this.agentRunning.get(kase.agentName) ?? 1) - 1;
    if (held <= 0) this.agentRunning.delete(kase.agentName);
    else this.agentRunning.set(kase.agentName, held);
    if (this.exclusive === kase) this.exclusive = null;
    for (const tag of kase.tags) this.heldTags.delete(tag);
    this.wake();
  }

  /** Release parked workers without freeing anything — for stop and drain. */
  wake(): void {
    this.generation += 1;
    const parked = this.waiters;
    this.waiters = [];
    for (const resume of parked) resume();
  }

  /**
   * Park until something is released, or the harness wakes us to shut down. `seen` is the
   * generation sampled before the `take()` that came back empty: if a wake landed in between,
   * this returns immediately rather than sleeping through it.
   */
  changed(seen: number): Promise<void> {
    if (seen !== this.generation) return Promise.resolve();
    return new Promise<void>((resolve) => {
      this.waiters.push(resolve);
    });
  }

  /** Why nothing can start, for the pane region when no agent is running. */
  blockedReason(): string | null {
    return this.blocked;
  }
}
