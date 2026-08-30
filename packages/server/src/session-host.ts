import {
  createDefaultAgentSessionFactory,
  inProcessHost,
  subprocessHost,
  type SessionHost,
} from "@pios/pi-host";
import type { ServerConfig } from "./config.ts";

/**
 * Builds the host the daemon runs sessions on.
 *
 * Both hosts satisfy the same contract, so the choice is configuration rather
 * than a rewrite: subprocess isolates a crashing pi to one child, in-process
 * skips the JSONL hop and the per-session spawn.
 */
export function createSessionHost(config: ServerConfig): SessionHost {
  const sessionDir = config.sessionDir;
  return config.sessionHostMode === "in-process"
    ? inProcessHost(createDefaultAgentSessionFactory({ sessionDir }))
    : subprocessHost({ sessionDir });
}
