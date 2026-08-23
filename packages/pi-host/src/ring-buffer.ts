import type { BufferedEvent, HostEvent } from "./types.ts";

/**
 * Bounded replay buffer for one session.
 *
 * Two cursors exist in this system and they are not interchangeable. An entry
 * id is durable and survives a process restart, but only covers what pi
 * persisted, which excludes an in-flight assistant message. A `seq` covers
 * every event including partials, but only for as long as the buffer holds it.
 * A client resyncs with the entry id and then tails with the seq.
 */
export class EventRingBuffer {
  private readonly capacity: number;
  private readonly items: BufferedEvent[] = [];
  private nextSeq = 1;

  constructor(capacity = 2000) {
    if (capacity < 1) throw new Error("ring buffer capacity must be positive");
    this.capacity = capacity;
  }

  push(event: HostEvent): BufferedEvent {
    const buffered: BufferedEvent = { seq: this.nextSeq++, at: Date.now(), event };
    this.items.push(buffered);
    if (this.items.length > this.capacity) this.items.shift();
    return buffered;
  }

  /** Highest seq issued, whether or not it is still buffered. */
  get lastSeq(): number {
    return this.nextSeq - 1;
  }

  get size(): number {
    return this.items.length;
  }

  /**
   * Events after `sinceSeq`. `gap` means the requested position has already
   * been evicted, so the tail is incomplete and the caller must refetch
   * entries rather than pretend it is caught up.
   */
  replay(sinceSeq?: number): { events: BufferedEvent[]; gap: boolean } {
    if (sinceSeq === undefined) {
      return { events: [...this.items], gap: this.evictedCount > 0 };
    }
    const oldest = this.items[0]?.seq;
    if (oldest === undefined) {
      return { events: [], gap: sinceSeq < this.lastSeq };
    }
    // A cursor at or past the last issued seq is caught up, not gapped.
    const gap = sinceSeq + 1 < oldest && sinceSeq < this.lastSeq;
    return { events: this.items.filter((i) => i.seq > sinceSeq), gap };
  }

  private get evictedCount(): number {
    return this.lastSeq - this.items.length;
  }
}
