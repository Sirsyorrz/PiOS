/**
 * Measures how long tools actually run.
 *
 * pi emits no timings, and wall time between its start and end events is the
 * wrong number: `tool_execution_start` fires *before* the tool asks for
 * confirmation, so a slow human turns a fast tool into a slow one. Spans where
 * a dialog is open are therefore subtracted. Dialogs are modal, so a span that
 * overlaps a concurrent call blocked that one too.
 *
 * Measurement uses a monotonic clock so a system clock step cannot produce a
 * negative duration; the value put on the wire is epoch-based, because clients
 * have to compare it against their own clock.
 */
export class ToolTimer {
  private readonly running = new Map<string, { start: number; excluded: number }>();
  private blockedDepth = 0;
  private blockedSince = 0;

  /** Returns the epoch start for the wire; measurement uses the monotonic one. */
  begin(toolCallId: string): number {
    this.running.set(toolCallId, { start: monotonic(), excluded: 0 });
    return Date.now();
  }

  /** A dialog opened: stop the clock on everything in flight. */
  block(): void {
    if (this.blockedDepth++ === 0) this.blockedSince = monotonic();
  }

  unblock(): void {
    if (this.blockedDepth === 0 || --this.blockedDepth > 0) return;
    const held = monotonic() - this.blockedSince;
    for (const entry of this.running.values()) entry.excluded += held;
  }

  /** Undefined for a call this timer never saw, e.g. one from before a restart. */
  end(toolCallId: string): number | undefined {
    const entry = this.running.get(toolCallId);
    if (!entry) return undefined;
    this.running.delete(toolCallId);
    return Math.max(0, monotonic() - entry.start - entry.excluded - this.heldSoFar());
  }

  /** Nothing survives an agent restart: the calls it was timing are gone. */
  reset(): void {
    this.running.clear();
    this.blockedDepth = 0;
  }

  /** Time inside a dialog that is still open, and so not yet distributed. */
  private heldSoFar(): number {
    return this.blockedDepth > 0 ? monotonic() - this.blockedSince : 0;
  }
}

function monotonic(): number {
  return Number(process.hrtime.bigint() / 1_000_000n);
}
