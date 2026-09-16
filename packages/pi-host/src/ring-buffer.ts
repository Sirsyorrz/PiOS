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
  /** Seq of the newest settle, i.e. where the in-flight turn begins. */
  private settledSeq = 0;

  constructor(capacity = 2000) {
    if (capacity < 1) throw new Error("ring buffer capacity must be positive");
    this.capacity = capacity;
  }

  push(event: HostEvent): BufferedEvent {
    const buffered: BufferedEvent = { seq: this.nextSeq++, at: Date.now(), event };
    if (isSettled(event)) this.settledSeq = buffered.seq;
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
   *
   * A cursor that never tailed this buffer, or one left over from an earlier
   * process, gets the in-flight turn only. Everything before the last settle
   * is on disk and reaches the client as entries; replaying it would push a
   * whole conversation's stream deltas at a client that already has it.
   */
  replay(sinceSeq?: number): { events: BufferedEvent[]; gap: boolean } {
    if (sinceSeq === undefined || sinceSeq <= 0 || sinceSeq > this.lastSeq) {
      const oldestHeld = this.items[0]?.seq;
      return {
        events: this.items.filter((i) => i.seq > this.settledSeq),
        // The turn itself outgrew the buffer, so even its tail is incomplete.
        gap: oldestHeld !== undefined && this.settledSeq + 1 < oldestHeld,
      };
    }
    const oldest = this.items[0]?.seq;
    if (oldest === undefined) {
      return { events: [], gap: sinceSeq < this.lastSeq };
    }
    // A cursor at or past the last issued seq is caught up, not gapped.
    const gap = sinceSeq + 1 < oldest && sinceSeq < this.lastSeq;
    return { events: this.items.filter((i) => i.seq > sinceSeq), gap };
  }
}

function isSettled(event: HostEvent): boolean {
  return event.type === "agent_event" && event.event.type === "agent_settled";
}
