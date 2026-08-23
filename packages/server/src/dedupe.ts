/**
 * Idempotency ledger for client commands.
 *
 * The outbox redelivers on every reconnect, so the same `commandId` will
 * arrive more than once whenever an ack is lost. Without this, a dropped ack
 * costs the user a duplicate prompt, which is worse than a lost one.
 *
 * Bounded by both age and count: a daemon that runs for months must not grow a
 * permanent record of every command ever sent.
 */
export class CommandLedger {
  private readonly seen = new Map<string, number>();
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private readonly now: () => number;

  constructor(options: { ttlMs?: number; maxEntries?: number; now?: () => number } = {}) {
    this.ttlMs = options.ttlMs ?? 24 * 60 * 60 * 1000;
    this.maxEntries = options.maxEntries ?? 10_000;
    this.now = options.now ?? Date.now;
  }

  /** True if this command is new. False means it was already applied. */
  claim(commandId: string): boolean {
    const now = this.now();
    this.evict(now);
    const seenAt = this.seen.get(commandId);
    if (seenAt !== undefined && now - seenAt < this.ttlMs) {
      return false;
    }
    this.seen.set(commandId, now);
    return true;
  }

  get size(): number {
    return this.seen.size;
  }

  private evict(now: number): void {
    for (const [id, at] of this.seen) {
      if (now - at < this.ttlMs) break;
      this.seen.delete(id);
    }
    // Insertion order is chronological, so the oldest keys go first.
    while (this.seen.size >= this.maxEntries) {
      const oldest = this.seen.keys().next();
      if (oldest.done) break;
      this.seen.delete(oldest.value);
    }
  }
}
