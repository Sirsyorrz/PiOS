import {
  createAgentSessionFromServices,
  createAgentSessionServices,
  resolveModelScopeWithDiagnostics,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
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

    const services = await createAgentSessionServices({
      cwd: createOptions.cwd,
      agentDir: options.agentDir,
    });
    // pi's own model scope (`enabledModels`) is what the picker offers first.
    // Without it every client would face the whole authenticated catalogue.
    const patterns = services.settingsManager.getEnabledModels() ?? [];
    const scopedModels = patterns.length
      ? (await resolveModelScopeWithDiagnostics(patterns, services.modelRuntime)).scopedModels
      : [];

    const { session } = await createAgentSessionFromServices({
      services,
      sessionManager,
      scopedModels,
    });
    return session as unknown as AgentSessionLike;
  };
}
