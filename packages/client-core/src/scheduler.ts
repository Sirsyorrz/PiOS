/**
 * Injected clock and timers.
 *
 * Every timing rule in this package is a policy decision worth testing
 * exactly: a 16s cap, a 30s stability window, a 10s background threshold.
 * Tests drive them with a fake clock rather than sleeping.
 */
export interface Scheduler {
  now(): number;
  setTimeout(fn: () => void, ms: number): TimerHandle;
  clearTimeout(handle: TimerHandle): void;
}

export type TimerHandle = { readonly __timer: unique symbol } | number | object;

export const systemScheduler: Scheduler = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms) as unknown as TimerHandle,
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export class FakeScheduler implements Scheduler {
  private current = 0;
  private nextId = 1;
  private timers = new Map<number, { at: number; fn: () => void }>();

  now(): number {
    return this.current;
  }

  setTimeout(fn: () => void, ms: number): TimerHandle {
    const id = this.nextId++;
    this.timers.set(id, { at: this.current + ms, fn });
    return id;
  }

  clearTimeout(handle: TimerHandle): void {
    this.timers.delete(handle as number);
  }

  /** Timers that are still armed. Used to assert that offline burns nothing. */
  get pending(): number {
    return this.timers.size;
  }

  /**
   * Fires only the next due timer and stops.
   *
   * `advance` jumps to a target and runs everything on the way, which makes a
   * sequence of backoff delays indistinguishable from one long wait. Tests
   * that measure individual delays step one timer at a time.
   */
  async runNext(): Promise<number | null> {
    const next = [...this.timers.entries()].sort((a, b) => a[1].at - b[1].at)[0];
    if (!next) return null;
    const [id, timer] = next;
    this.timers.delete(id);
    const waited = timer.at - this.current;
    this.current = timer.at;
    timer.fn();
    await flush();
    return waited;
  }

  /** Advances time, firing timers in order, including ones they schedule. */
  async advance(ms: number): Promise<void> {
    const target = this.current + ms;
    for (;;) {
      const next = [...this.timers.entries()]
        .filter(([, timer]) => timer.at <= target)
        .sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      const [id, timer] = next;
      this.timers.delete(id);
      this.current = Math.max(this.current, timer.at);
      timer.fn();
      await flush();
    }
    this.current = target;
    await flush();
  }
}

/** Lets already-resolved promise chains run before assertions. */
export function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}
