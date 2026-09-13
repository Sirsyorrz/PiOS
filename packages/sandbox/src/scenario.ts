import type { EntrySeed } from "./transcript.ts";
import type { RepoSpec } from "./repo.ts";

/**
 * A scenario is data, not a script.
 *
 * Driving the stub through a conversation to reach the state a bug needs is
 * slow and fragile; declaring the end state means one flag reproduces it, and
 * the same declaration doubles as a regression fixture.
 */
export interface SessionSpec {
  /** Stable id: also the session file name, so seeds land where pi looks. */
  id: string;
  name: string;
  /**
   * Git fixture for this session's cwd. Omitted means a clean repo; `false`
   * means a plain directory, which is what the "not a repository" UI needs.
   */
  repo?: RepoSpec | false;
  entries?: EntrySeed[];
}

export interface Scenario {
  name: string;
  description: string;
  sessions: SessionSpec[];
  /** Session the app opens on, when the client has no opinion of its own. */
  active?: string;
  /**
   * Idle time before a session's process is reaped. Tiny values make the cold
   * path, which is the normal resting state, reachable in a screenshot.
   */
  sessionIdleMs?: number;
}

export function scenario(name: string, spec: Omit<Scenario, "name">): Scenario {
  return { name, ...spec };
}
