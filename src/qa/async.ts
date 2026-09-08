import { constants as osConstants } from "node:os";

/** A latch workers await while dispatch is paused. Opening it wakes everyone at once. */
export class Gate {
  private opened: boolean;
  private waiters: Array<() => void> = [];

  constructor(opened = true) {
    this.opened = opened;
  }

  get isOpen(): boolean {
    return this.opened;
  }

  set(opened: boolean): void {
    this.opened = opened;
    if (!opened) return;
    const pending = this.waiters;
    this.waiters = [];
    for (const wake of pending) wake();
  }

  wait(): Promise<void> {
    if (this.opened) return Promise.resolve();
    return new Promise<void>((resolve) => {
      this.waiters.push(resolve);
    });
  }
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export function signalNumber(sig: NodeJS.Signals): number {
  return (osConstants.signals as unknown as Record<string, number>)[sig] ?? 0;
}

/**
 * Actions that must run exactly once, on every exit path. LIFO, idempotent, synchronous only —
 * a `process.on('exit')` handler cannot await. The terminal restore and the lock release both
 * register here rather than installing competing handlers that fight over process.exit.
 *
 * Signals are deliberately NOT handled here: the harness maps them to requestStop() so a run
 * unwinds gracefully, and the resulting normal exit fires this via 'exit'.
 */
export class Cleanup {
  private actions: Array<() => void> = [];
  private ran = false;
  private installed = false;

  add(action: () => void): void {
    this.actions.push(action);
  }

  run(): void {
    if (this.ran) return;
    this.ran = true;
    for (const action of [...this.actions].reverse()) {
      try {
        action();
      } catch {
        /* a failing cleanup must not block the others */
      }
    }
  }

  install(onFatal: (err: unknown) => void): void {
    if (this.installed) return;
    this.installed = true;
    process.on("exit", () => this.run());
    const fatal = (err: unknown): void => {
      this.run();
      onFatal(err);
      process.exit(1);
    };
    process.on("uncaughtException", fatal);
    process.on("unhandledRejection", fatal);
  }
}
