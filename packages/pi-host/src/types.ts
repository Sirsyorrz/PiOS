import type {
  AgentEvent,
  CommandOption,
  ModelOption,
  ExtensionUiRequest,
  ExtensionUiResponse,
  ImageContent,
  SessionPresentation,
  SessionEntry,
  StreamingBehavior,
} from "@pios/protocol";

export type SessionStatus = "starting" | "idle" | "running" | "crashed" | "disposed";

/**
 * Everything the daemon publishes for one session.
 *
 * Status changes and recovery notices ride the same stream as agent events so
 * that a reconnecting client replays them in the order they happened, instead
 * of reconstructing ordering from two sources.
 */
export type HostEvent =
  | { type: "agent_event"; event: AgentEvent }
  | { type: "extension_ui_request"; request: ExtensionUiRequest }
  | { type: "extension_ui_closed"; id: string }
  | { type: "status"; status: SessionStatus }
  | { type: "session_recovered"; leafId: string | null; reason: string };

export interface BufferedEvent {
  seq: number;
  at: number;
  event: HostEvent;
}

export interface EntriesPage {
  entries: SessionEntry[];
  leafId: string | null;
  /**
   * The cursor was not recognised, so `entries` is the whole session and the
   * client must discard what it had. pi fails an unknown `since` outright; the
   * host turns that into a reset rather than surfacing it as an error.
   */
  reset: boolean;
}

export interface PromptOptions {
  images?: ImageContent[];
  /** Required while the agent streams. Ignored when it is idle. */
  streamingBehavior?: StreamingBehavior;
}

export interface ModelListing {
  models: ModelOption[];
  /** True when this is the full catalogue, including when there is no scope. */
  all: boolean;
}

export interface PromptResult {
  accepted: boolean;
  error?: string;
}

export interface SessionInfo {
  id: string;
  cwd: string;
  name?: string;
  /** Whether project-local extensions, settings, and packages were loaded. */
  trusted: boolean;
  status: SessionStatus;
  /** Blocked on an extension dialog: running, but waiting on a human. */
  awaitingInput: boolean;
  sessionFile?: string;
  /** Durable cursor: the last entry pi persisted. */
  leafId: string | null;
  /** Live cursor: the newest buffered event, including in-flight partials. */
  lastSeq: number;
  updatedAt: number;
  /** First user message, absent until one is seen. */
  preview?: string;
  /** Active model, absent until pi resolves one. */
  model?: ModelOption;
  /** Effective thinking level, absent until pi resolves one. */
  thinkingLevel?: string;
  /** Levels the active model accepts; `["off"]` for a model without reasoning. */
  thinkingLevels: string[];
}

export interface PiSession {
  readonly id: string;
  readonly info: SessionInfo;

  prompt(text: string, options?: PromptOptions): Promise<PromptResult>;
  steer(text: string, images?: ImageContent[]): Promise<PromptResult>;
  followUp(text: string, images?: ImageContent[]): Promise<PromptResult>;

  /** Delta since a durable entry id, or the whole session when omitted. */
  getEntries(since?: string): Promise<EntriesPage>;

  interrupt(): Promise<void>;
  dispose(): Promise<void>;

  /** Dialogs waiting on a human, oldest first. Survives client reconnects. */
  readonly pendingDialogs: ExtensionUiRequest[];
  /** Current status lines, widgets and title asked for by extensions. */
  readonly presentation: SessionPresentation;
  /** First answer wins; a stale or unknown id is ignored. */
  answerDialog(response: ExtensionUiResponse): boolean;

  /** The session's model scope, or the whole catalogue when asked for it. */
  listModels(options?: { all?: boolean }): Promise<ModelListing>;
  /** Slash commands invokable via `prompt`; excludes built-in TUI commands. */
  listCommands(): Promise<CommandOption[]>;
  setModel(provider: string, modelId: string): Promise<void>;
  setThinkingLevel(level: string): Promise<void>;

  /**
   * Reloads the session under a different project trust, in place.
   *
   * pi takes trust from its launch flags, so this replaces the agent; the
   * session id, transcript, and subscribers survive it.
   */
  setProjectTrust(trustProject: boolean): Promise<void>;

  subscribe(listener: (event: BufferedEvent) => void): () => void;
  /** Buffered events after `sinceSeq`, for a client that was away. */
  replay(sinceSeq?: number): { events: BufferedEvent[]; gap: boolean };
}

export interface CreateSessionOptions {
  id?: string;
  cwd: string;
  name?: string;
  /**
   * Explicit, never inherited. pi's headless trust behaviour depends on
   * machine state, so the daemon decides per session and reports what it did.
   */
  trustProject?: boolean;
  model?: string;
  /** Resume an existing session file instead of starting a new one. */
  resumeFrom?: string;
}
