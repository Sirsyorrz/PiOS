import { createAgentSession, SessionManager } from "@earendil-works/pi-coding-agent";
import type { AgentSessionFactory, AgentSessionLike } from "./in-process.ts";

export interface DefaultFactoryOptions {
  sessionDir?: string;
  agentDir?: string;
}

/**
 * Builds real `AgentSession` instances.
 *
 * Split out from `InProcessSession` so the host can be tested without an API
 * key, and so the daemon can swap in a container-scoped factory later without
 * touching session logic.
 */
export function createDefaultAgentSessionFactory(
  options: DefaultFactoryOptions = {},
): AgentSessionFactory {
  return async (createOptions) => {
    const sessionManager = createOptions.resumeFrom
      ? SessionManager.open(createOptions.resumeFrom, options.sessionDir, createOptions.cwd)
      : SessionManager.create(createOptions.cwd, options.sessionDir);

    const { session } = await createAgentSession({
      cwd: createOptions.cwd,
      agentDir: options.agentDir,
      sessionManager,
    });
    return session as unknown as AgentSessionLike;
  };
}
