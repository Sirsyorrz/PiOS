import type { SessionStats, SessionSummary } from "@pios/protocol";
import { useEffect, useState } from "react";
import { useClient } from "../client-provider.tsx";
import { collapseHome } from "../format.ts";
import { contextLine, cost } from "./session-stats.tsx";
import { FactRow, PickerHeader } from "./ui.tsx";

/**
 * pi's `/session`: where the session lives and what it has cost so far.
 *
 * Docks where the composer was, like a dialog, so the transcript it describes
 * stays in view. The numbers are asked for again on open: the cached ones are
 * from the last time the agent stopped.
 */
export function SessionInfo({ sessionId, session, onClose }: {
  sessionId: string;
  session: SessionSummary | null;
  onClose: () => void;
}) {
  const client = useClient();
  const [stats, setStats] = useState<SessionStats | null>(() => client.getStats(sessionId));

  useEffect(() => {
    const off = client.onStats((changed, next) => {
      if (changed === sessionId) setStats(next);
    });
    client.requestStats(sessionId);
    return off;
  }, [client, sessionId]);

  const facts = sessionFacts(sessionId, session, stats);
  return (
    <section className="dialog">
      <PickerHeader title="Session" onCancel={onClose} />
      <div className="scroll-y">
        {facts.map((fact) => (
          <FactRow key={fact.label} {...fact} />
        ))}
      </div>
    </section>
  );
}

interface Fact {
  label: string;
  value: string;
  path?: boolean;
}

function sessionFacts(
  sessionId: string,
  session: SessionSummary | null,
  stats: SessionStats | null,
): Fact[] {
  const facts: Fact[] = [];
  const add = (label: string, value: string | null | undefined, path = false) => {
    if (value) facts.push({ label, value, path });
  };
  add("Name", session?.name);
  add("Directory", session?.cwd && collapseHome(session.cwd), true);
  add("File", stats?.sessionFile && collapseHome(stats.sessionFile), true);
  add("ID", stats?.sessionId ?? sessionId);
  add("Model", session?.model && `${session.model.provider}/${session.model.modelId}`);
  add("Messages", stats && counts([
    ["user", stats.userMessages],
    ["assistant", stats.assistantMessages],
    ["total", stats.totalMessages],
  ]));
  add("Tools", stats && counts([
    ["calls", stats.toolCalls],
    ["results", stats.toolResults],
  ]));
  const tokens = stats?.tokens;
  add("Tokens", tokens && counts([
    ["in", tokens.input],
    ["out", tokens.output],
    ["cache read", tokens.cacheRead],
    ["cache write", tokens.cacheWrite],
    ["total", tokens.total],
  ]));
  add("Cost", stats?.cost === undefined ? undefined : cost(stats.cost));
  add("Context", stats ? (contextLine(stats) ?? undefined) : undefined);
  return facts;
}

/** Exact figures: this is the place to read them, the footer rounds. */
function counts(parts: [label: string, value: number | undefined][]): string | undefined {
  const known = parts.filter((part): part is [string, number] => part[1] !== undefined);
  if (known.length === 0) return undefined;
  return known.map(([label, value]) => `${value.toLocaleString()} ${label}`).join(", ");
}
