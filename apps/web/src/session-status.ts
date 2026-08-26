import type { SessionSummary } from "@pios/protocol";

/**
 * The one place a session's state becomes a word and a tone.
 *
 * The list and the open session read the same fields, so they must not decide
 * this separately: a row that says "running" beside a header that says
 * "waiting" is a bug the user has to resolve by guessing.
 */
export interface SessionState {
  /** Also the CSS modifier, on both `.badge` and `.status`. */
  tone: string;
  label: string;
}

export function sessionState(
  session: SessionSummary | undefined,
  live?: { running?: boolean; interrupting?: boolean; blocked?: boolean },
): SessionState {
  // Untrusted comes first: nothing else the session reports is meaningful
  // until the user decides whether its project may load code.
  if (session && !session.trusted) return { tone: "untrusted", label: "untrusted" };
  // Blocked on a dialog beats running. The agent has a turn in flight, but it
  // is stopped on a human, and only "waiting" tells the user to act.
  if (live?.blocked || session?.awaitingInput) return { tone: "waiting", label: "waiting" };
  if (live?.interrupting) return { tone: "running", label: "stopping" };
  if (live?.running) return { tone: "running", label: "running" };
  const status = session?.status ?? "idle";
  return { tone: status, label: status };
}
