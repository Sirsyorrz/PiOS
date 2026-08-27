import type { AgentEvent, ImageContent, ModelOption, SessionEntry } from "@pios/protocol";
import { AgentEventSchema } from "@pios/protocol";
import { BaseSession } from "./base-session.ts";
import { sliceEntriesSince } from "./entries.ts";
import type {
  CreateSessionOptions,
  EntriesPage,
  ModelListing,
  PiSession,
  PromptOptions,
  PromptResult,
} from "./types.ts";

/**
 * The slice of pi's `AgentSession` this host uses.
 *
 * Structural rather than imported so the host can be driven by a stub in
 * tests. The real `AgentSession` satisfies it as-is.
 */
/** The parts of a pi-ai `Model` this host reads. */
export interface AgentModelLike {
  id: string;
  name: string;
  provider: string;
}

export interface AgentSessionLike {
  readonly isStreaming: boolean;
  readonly model?: AgentModelLike;
  /** Models pi was scoped to (`--models`), empty when unscoped. */
  readonly scopedModels?: ReadonlyArray<{ model: AgentModelLike }>;
  readonly modelRuntime?: {
    getAvailable(): Promise<readonly AgentModelLike[]>;
    getModel(provider: string, modelId: string): AgentModelLike | undefined;
  };
  setModel?(model: AgentModelLike): Promise<void>;
  readonly thinkingLevel?: string;
  setThinkingLevel?(level: string): void;
  getAvailableThinkingLevels?(): string[];
  readonly sessionId: string;
  readonly sessionFile: string | undefined;
  readonly sessionManager: {
    getEntries(): SessionEntry[];
    getLeafId(): string | null;
  };
  subscribe(listener: (event: unknown) => void): () => void;
  prompt(
    text: string,
    options?: {
      images?: ImageContent[];
      streamingBehavior?: "steer" | "followUp";
      /** Fires once the prompt is accepted or rejected, before the run ends. */
      preflightResult?: (success: boolean) => void;
    },
  ): Promise<void>;
  steer(text: string, images?: ImageContent[]): Promise<void>;
  followUp(text: string, images?: ImageContent[]): Promise<void>;
  abort(): Promise<void>;
  dispose(): void;
}

export type AgentSessionFactory = (
  options: CreateSessionOptions,
) => Promise<AgentSessionLike>;

/**
 * Session backed by an in-process `AgentSession`.
 *
 * Events arrive as objects rather than JSON, so there is no framing layer, but
 * they are still validated: an event shape this build does not understand is
 * dropped with a warning instead of being forwarded to clients as an unusable
 * frame.
 */
export class InProcessSession extends BaseSession implements PiSession {
  private agent: AgentSessionLike | null = null;
  private unsubscribe: (() => void) | null = null;
  private readonly factory: AgentSessionFactory;
  private readonly createOptions: CreateSessionOptions;
  private disposed = false;

  private constructor(
    id: string,
    options: CreateSessionOptions,
    factory: AgentSessionFactory,
  ) {
    super({ id, cwd: options.cwd, name: options.name, trusted: options.trustProject ?? false });
    this.createOptions = options;
    this.factory = factory;
  }

  static async start(
    options: CreateSessionOptions,
    factory: AgentSessionFactory,
  ): Promise<InProcessSession> {
    const session = new InProcessSession(options.id ?? crypto.randomUUID(), options, factory);
    await session.attach();
    return session;
  }

  private async attach(): Promise<void> {
    // A fresh agent has no memory of the calls the old one had in flight.
    this.resetToolTimings();
    const agent = await this.factory(this.createOptions);
    this.agent = agent;
    this.sessionFile = agent.sessionFile;
    this.setLeafId(agent.sessionManager.getLeafId());
    this.unsubscribe = agent.subscribe((raw) => this.onAgentEvent(raw));
    this.setModelInfo(this.describe(agent.model));
    this.readThinking();
    this.setStatus(agent.isStreaming ? "running" : "idle");
  }

  private onAgentEvent(raw: unknown): void {
    const parsed = AgentEventSchema.safeParse(raw);
    if (!parsed.success) {
      const type = (raw as { type?: unknown })?.type;
      console.warn(`[pi-host] dropping unrecognised event ${String(type)} on session ${this.id}`);
      return;
    }
    const event: AgentEvent = parsed.data;
    this.observeAgentEvent(event);
    // pi can move the model itself (cycling, a fallback after an auth error),
    // so the summary is refreshed from the agent rather than only on our own
    // set_model.
    if (event.type === "agent_start" || event.type === "agent_settled") {
      this.setModelInfo(this.describe(this.agent?.model));
      this.readThinking();
    }
    if (event.type === "message_end" || event.type === "agent_settled") {
      this.setLeafId(this.agent?.sessionManager.getLeafId() ?? this.leafId);
    }
    this.publish({ type: "agent_event", event });
  }

  async prompt(text: string, options: PromptOptions = {}): Promise<PromptResult> {
    const agent = this.requireAgent();
    if (agent.isStreaming && !options.streamingBehavior) {
      // Same rejection pi's RPC mode gives, produced before the call so the
      // caller sees one consistent error regardless of host.
      return {
        accepted: false,
        error:
          "Agent is already processing. Specify streamingBehavior ('steer' or 'followUp') to queue the message.",
      };
    }
    // `AgentSession.prompt()` resolves when the whole run finishes, which can
    // be minutes. A client is waiting on delivery, not completion, so this
    // resolves at preflight and lets the run continue in the background.
    // Failures after acceptance arrive as events, exactly as in RPC mode.
    return new Promise<PromptResult>((resolve) => {
      let done = false;
      const finish = (result: PromptResult) => {
        if (done) return;
        done = true;
        resolve(result);
      };
      agent
        .prompt(text, {
          images: options.images,
          // Passing a behaviour while idle would be rejected upstream.
          streamingBehavior: agent.isStreaming ? options.streamingBehavior : undefined,
          preflightResult: (success) => {
            if (success) finish({ accepted: true });
          },
        })
        .then(() => finish({ accepted: true }))
        .catch((error: unknown) => finish({ accepted: false, error: messageOf(error) }));
    });
  }

  async steer(text: string, images?: ImageContent[]): Promise<PromptResult> {
    return this.guard(() => this.requireAgent().steer(text, images));
  }

  async followUp(text: string, images?: ImageContent[]): Promise<PromptResult> {
    return this.guard(() => this.requireAgent().followUp(text, images));
  }

  async getEntries(since?: string): Promise<EntriesPage> {
    const manager = this.requireAgent().sessionManager;
    const leafId = manager.getLeafId();
    this.setLeafId(leafId);
    const entries = manager.getEntries();
    this.observeEntries(entries);
    return sliceEntriesSince(entries, leafId, since);
  }

  async listModels(options: { all?: boolean } = {}): Promise<ModelListing> {
    const agent = this.requireAgent();
    const scoped = agent.scopedModels ?? [];
    if (!options.all && scoped.length > 0) {
      return { models: scoped.map((entry) => this.describe(entry.model)!), all: false };
    }
    const keys = new Set(scoped.map((entry) => key(entry.model.provider, entry.model.id)));
    const available = (await agent.modelRuntime?.getAvailable()) ?? [];
    return {
      models: available.map((model) => ({
        provider: model.provider,
        modelId: model.id,
        name: model.name,
        scoped: keys.has(key(model.provider, model.id)),
      })),
      all: true,
    };
  }

  async setModel(provider: string, modelId: string): Promise<void> {
    const agent = this.requireAgent();
    if (!agent.setModel) throw new Error("this host cannot switch models");
    const model = agent.modelRuntime?.getModel(provider, modelId);
    if (!model) throw new Error(`unknown model ${key(provider, modelId)}`);
    await agent.setModel(model);
    this.setModelInfo(this.describe(agent.model ?? model));
    // pi clamps the level to what the new model supports.
    this.readThinking();
  }

  async setThinkingLevel(level: string): Promise<void> {
    const agent = this.requireAgent();
    if (!agent.setThinkingLevel) throw new Error("this host cannot set a thinking level");
    agent.setThinkingLevel(level);
    this.readThinking();
  }

  private readThinking(): void {
    const agent = this.agent;
    this.setThinkingInfo(agent?.thinkingLevel, agent?.getAvailableThinkingLevels?.() ?? []);
  }

  private describe(model: AgentModelLike | undefined): ModelOption | undefined {
    if (!model) return undefined;
    const scoped = (this.agent?.scopedModels ?? []).some(
      (entry) => key(entry.model.provider, entry.model.id) === key(model.provider, model.id),
    );
    return { provider: model.provider, modelId: model.id, name: model.name, scoped };
  }

  async interrupt(): Promise<void> {
    await this.requireAgent().abort();
    this.setStatus("idle");
  }

  /**
   * No extension UI context is installed on the in-process agent, so nothing
   * can be waiting on an answer here.
   */
  answerDialog(): boolean {
    return false;
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.unsubscribe?.();
    this.unsubscribe = null;
    try {
      this.agent?.dispose();
    } finally {
      this.agent = null;
      this.setStatus("disposed");
      this.clearListeners();
    }
  }

  /**
   * Rebuilds the underlying agent from the persisted session file.
   *
   * In-process there is no child to die, but an unrecoverable error inside the
   * agent leaves the session unusable in the same way, and the fix is the
   * same: reload from what pi persisted.
   */
  async restart(reason: string): Promise<void> {
    this.setStatus("crashed");
    await this.relaunch(reason);
  }

  /** Same contract as the subprocess host: same session id, new trust. */
  async setProjectTrust(trustProject: boolean): Promise<void> {
    if (this.disposed || this.trusted === trustProject) return;
    this.createOptions.trustProject = trustProject;
    this.setTrusted(trustProject);
    this.setStatus("starting");
    await this.relaunch(trustProject ? "directory trusted" : "trust revoked");
  }

  private async relaunch(reason: string): Promise<void> {
    this.unsubscribe?.();
    try {
      this.agent?.dispose();
    } catch {
      /* the agent is already broken */
    }
    this.agent = null;
    await this.attach();
    this.publish({ type: "session_recovered", leafId: this.leafId, reason });
  }

  private requireAgent(): AgentSessionLike {
    if (!this.agent) throw new Error(`session ${this.id} is not running`);
    return this.agent;
  }

  private async guard(action: () => Promise<void>): Promise<PromptResult> {
    try {
      await action();
      return { accepted: true };
    } catch (error) {
      return { accepted: false, error: messageOf(error) };
    }
  }
}

function key(provider: string, modelId: string): string {
  return `${provider}/${modelId}`;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
