import { scenario } from "../scenario.ts";
import { say, user } from "../transcript.ts";

/**
 * Sessions with no process behind them, which is where a session spends most
 * of its life: the transcript is on disk and the next command wakes it.
 */
export default scenario("cold", {
  description: "Reaped sessions: listed and readable with no agent running.",
  // Zero would disable the sweep; one millisecond means everything is idle.
  sessionIdleMs: 1,
  sessions: [
    {
      id: "sbx-cold",
      name: "reaped",
      entries: [user("Does this still work after a reap?"), say("It does: the file is the session.")],
    },
  ],
});
