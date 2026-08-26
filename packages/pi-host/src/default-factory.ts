import { createAgentSession, SessionManager } from "@earendil-works/pi-coding-agent";
import type { AgentSessionFactory, AgentSessionLike } from "./in-process.ts";
import { projectSessionDir } from "./session-paths.ts";

export interface DefaultFactoryOptions {
  /** Root holding one directory per project, i.e. `~/.pi/agent/sessions`. */
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
    // SessionManager takes the project's directory, not the root above it.
    const dir = options.sessionDir
      ? projectSessionDir(createOptions.cwd, options.sessionDir)
      : undefined;
    const sessionManager = createOptions.resumeFrom
      ? SessionManager.open(createOptions.resumeFrom, dir, createOptions.cwd)
      : SessionManager.create(createOptions.cwd, dir);

    const { session } = await createAgentSession({
      cwd: createOptions.cwd,
      agentDir: options.agentDir,
      sessionManager,
    });
    return session as unknown as AgentSessionLike;
  };
}
