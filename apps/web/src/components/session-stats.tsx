import type { SessionStats } from "@pios/protocol";
import { useEffect, useLayoutEffect, useState } from "react";
import { useClient } from "../client-provider.tsx";
import { compactCount } from "../format.ts";

/**
 * Token, cost and context accounting for the session, under the transcript.
 *
 * Asked for rather than pushed: the numbers only settle between turns, so they
 * are re-fetched when the agent stops running instead of ticking mid-stream.
 */
export function SessionStatsFooter({ sessionId, running, onResize }: {
  sessionId: string;
  running: boolean;
  /** The footer lands after the transcript pinned itself; re-pin without it. */
  onResize?: () => void;
}) {
  const client = useClient();
  const [stats, setStats] = useState<SessionStats | null>(() => client.getStats(sessionId));

  useEffect(() => {
    setStats(client.getStats(sessionId));
    return client.onStats((changed, next) => {
      if (changed === sessionId) setStats(next);
    });
  }, [client, sessionId]);

  useEffect(() => {
    if (running) return;
    client.requestStats(sessionId);
  }, [client, sessionId, running]);

  useLayoutEffect(() => {
    if (stats) onResize?.();
  }, [stats, onResize]);

  if (!stats) return null;
  const context = contextLine(stats);
  return (
    <div className="session-stats">
      {tokens(stats)}
      {stats.cost === undefined ? null : <span>{cost(stats.cost)}</span>}
      {context ? <span>{context}</span> : null}
    </div>
  );
}

function tokens(stats: SessionStats) {
  const total = stats.tokens?.total;
  if (total === undefined) return null;
  return <span>{compactCount(total)} tokens</span>;
}

/** Null until pi knows the window, and again until a post-compaction reply. */
function contextLine(stats: SessionStats): string | null {
  const usage = stats.contextUsage;
  if (!usage || usage.tokens == null) return null;
  const window = usage.contextWindow;
  const percent = usage.percent;
  const of = window ? ` of ${compactCount(window)}` : "";
  return `context ${compactCount(usage.tokens)}${of}${percent == null ? "" : ` (${Math.round(percent)}%)`}`;
}

function cost(amount: number): string {
  // Sub-cent turns are the common case, so two decimals would read as free.
  const digits = amount > 0 && amount < 0.01 ? 4 : 2;
  return `$${amount.toFixed(digits)}`;
}
