import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { resolve as resolvePath } from "node:path";
import { SettingsManager } from "@earendil-works/pi-coding-agent";
import type {
  BashResult,
  CommandOption,
  ExtensionUiResponse,
  ImageContent,
  ModelOption,
  SessionStats,
} from "@pios/protocol";
import {
  AgentEventSchema,
  BashResultSchema,
  ExtensionUiRequestSchema,
  GetEntriesDataSchema,
  RpcResponseSchema,
  SessionStateSchema,
  SessionStatsSchema,
  ThinkingLevelsDataSchema,
  isDialogRequest,
  isUnknownCursorError,
  type RpcResponse,
} from "@pios/protocol";
import { JsonlFramer, encodeJsonl } from "@pios/protocol/jsonl";
import { BaseSession } from "./base-session.ts";
import { messageOf } from "./errors.ts";
import { projectSessionDir } from "./session-paths.ts";
import { readTranscript, sliceEntries } from "./transcript-file.ts";
import type {
  CreateSessionOptions,
  EntriesPage,
  ModelListing,
  BranchSessionFile,
  PiSession,
  PromptOptions,
  PromptResult,
} from "./types.ts";

export interface SubprocessOptions {
  /** Overridable so tests can drive a stub binary instead of real pi. */
  command?: string;
  /** Inserted before pi's own arguments, for a wrapper or interpreter. */
  argsPrefix?: string[];
  extraArgs?: string[];
  /** Root holding one directory per project, i.e. `~/.pi/agent/sessions`. */
  sessionDir?: string;
  /** pi's global config directory, for reading its model scope. */
  agentDir?: string;
  env?: NodeJS.ProcessEnv;
  /** Overridable so tests can branch a stub's session format. */
  branchSessionFile?: BranchSessionFile;
  requestTimeoutMs?: number;
  /** Separate from `requestTimeoutMs`: a build or a test run is not a hang. */
  bashTimeoutMs?: number;
  /** Upper bound on an unanswered extension dialog. See `dialogTimers`. */
  dialogTimeoutMs?: number;
  /** How long a stopped child gets to exit on SIGTERM before SIGKILL. */
  killGraceMs?: number;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 120_000;
const DEFAULT_KILL_GRACE_MS = 5_000;
const DEFAULT_BASH_TIMEOUT_MS = 30 * 60_000;
const DEFAULT_DIALOG_TIMEOUT_MS = 10 * 60_000;
/** A summary of a long session is a model call over all of it. */
const COMPACT_TIMEOUT_MS = 30 * 60_000;

/**
 * Session backed by a `pi --mode rpc` child process.
 *
 * Kept alongside the in-process host for two reasons: it is the reference
 * implementation the RPC docs describe, and it isolates a crash to one session
 * instead of the whole daemon.
 */
export class SubprocessSession extends BaseSession implements PiSession {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private framer = new JsonlFramer();
  private readonly pending = new Map<
    string,
    { resolve: (r: RpcResponse) => void; timer: NodeJS.Timeout }
  >();
  private seq = 0;
  private disposed = false;
  /**
   * pi only arms its own timer when the extension passes `timeout`, and most
   * do not. An unanswered dialog then blocks the agent forever, so every
   * dialog gets a deadline here and is cancelled on expiry.
   */
  private readonly dialogTimers = new Map<string, NodeJS.Timeout>();
  /** Set when the child could not be spawned at all, e.g. pi is not on PATH. */
  private spawnError: Error | null = null;
  private readonly options: SubprocessOptions;
  private readonly createOptions: CreateSessionOptions;
  private onExit: ((info: { code: number | null; signal: string | null }) => void) | null = null;

  private constructor(
    id: string,
    createOptions: CreateSessionOptions,
    options: SubprocessOptions,
  ) {
    super({
      id,
      cwd: createOptions.cwd,
      name: createOptions.name,
      trusted: createOptions.trustProject ?? false,
      branchSessionFile: options.branchSessionFile,
    });
    this.createOptions = { ...createOptions, id };
    this.options = options;
  }

  static async start(
    createOptions: CreateSessionOptions,
    options: SubprocessOptions = {},
  ): Promise<SubprocessSession> {
    const session = new SubprocessSession(
      createOptions.id ?? crypto.randomUUID(),
      createOptions,
      options,
    );
    await session.spawnChild();
    return session;
  }

  /** Called when the child exits unexpectedly, so the registry can recover. */
  setExitHandler(handler: (info: { code: number | null; signal: string | null }) => void): void {
    this.onExit = handler;
  }

  private buildArgs(): string[] {
    // A relaunch binds to the exact file pi reported, not to a project lookup
    // by id: the lookup is scoped to the project and misses when the session
    // was never persisted or the directory resolves differently, and a miss
    // silently starts an empty session under the same id.
    const resumeFrom = this.sessionFile ?? this.createOptions.resumeFrom;
    const args = resumeFrom
      ? ["--mode", "rpc", "--session", resumeFrom]
      : ["--mode", "rpc", "--session-id", this.id];
    // pi wants the project's own directory here, not the root above it:
    // passing the root writes sessions flat, where `/resume` never looks.
    if (this.options.sessionDir) {
      args.push(
        "--session-dir",
        projectSessionDir(this.createOptions.cwd, this.options.sessionDir),
      );
    }
    // Always explicit. pi's headless trust default depends on machine state,
    // and a session that silently loses project extensions is worse than one
    // that reports being untrusted.
    args.push(this.createOptions.trustProject ? "--approve" : "--no-approve");
    // Only for a session being born. A file already holds its name and model,
    // and repeating the ones it was created with on every wake would undo
    // whatever was switched or renamed since.
    if (!resumeFrom) {
      if (this.createOptions.model) args.push("--model", this.createOptions.model);
      if (this.createOptions.name) args.push("--name", this.createOptions.name);
    }
    return [...(this.options.argsPrefix ?? []), ...args, ...(this.options.extraArgs ?? [])];
  }

  private async spawnChild(): Promise<void> {
    this.framer = new JsonlFramer({
      onOverflow: (limit) =>
        console.warn(`[pi-host] session ${this.id} dropped a record over ${limit} bytes`),
    });
    this.spawnError = null;
    const command = this.options.command ?? "pi";
    const proc = spawn(command, this.buildArgs(), {
      cwd: this.createOptions.cwd,
      env: this.options.env ?? process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.proc = proc;

    proc.stdout.on("data", (chunk: Buffer) => {
      for (const record of this.framer.push(chunk)) this.onRecord(record);
    });
    proc.stderr.on("data", (chunk: Buffer) => {
      console.warn(`[pi-host] session ${this.id} stderr: ${String(chunk).trimEnd()}`);
    });
    proc.on("exit", (code, signal) => this.handleExit(code, signal));
    // Without this listener a failed spawn is an unhandled `error` event,
    // which takes down the whole daemon and every other session with it.
    proc.on("error", (error) => {
      this.spawnError =
        (error as NodeJS.ErrnoException).code === "ENOENT"
          ? new Error(`cannot run "${command}": not found on PATH`)
          : error;
      this.handleExit(null, null);
    });

    this.setStatus("idle");
    const state = await this.request({ type: "get_state" });
    // Surfaced as a failed create rather than a session that exists and can
    // never answer anything.
    if (this.spawnError) throw this.spawnError;
    if (state.success) {
      const data = state.data as
        | {
            sessionFile?: string;
            isStreaming?: boolean;
            model?: RpcModel;
            thinkingLevel?: string;
            sessionName?: string;
            autoCompactionEnabled?: boolean;
          }
        | undefined;
      this.sessionFile = data?.sessionFile;
      this.recordModel(toModelOption(data?.model));
      this.recordName(data?.sessionName);
      this.recordAutoCompaction(data?.autoCompactionEnabled);
      await this.refreshThinking(data?.thinkingLevel);
      if (data?.isStreaming) this.setStatus("running");
    }
    try {
      const page = await this.getEntries();
      this.setLeafId(page.leafId);
    } catch {
      // The child can die again during startup. Keep the last known leaf and
      // let the exit handler drive recovery rather than failing the spawn.
    }
  }

  private onRecord(record: string): void {
    // Extensions write to the same stdout, and terminal control bytes carry no
    // newline of their own, so a bell lands glued to the front of the next
    // record. Stripping them here keeps one stray byte from eating an event.
    //
    // ESC is left alone: a themed string arrives as an escaped \u001b inside
    // JSON, and removing raw ESC bytes would only corrupt half of a sequence
    // that the presentation reducer strips properly later.
    const cleaned = record.replace(/[\u0000-\u0008\u000B-\u001A\u001C-\u001F\u007F]/g, "").trim();
    if (!cleaned) return;

    let json: unknown;
    try {
      json = JSON.parse(cleaned);
    } catch {
      console.warn(`[pi-host] session ${this.id} emitted unparseable JSON`);
      return;
    }

    const response = RpcResponseSchema.safeParse(json);
    if (response.success) {
      this.settle(response.data);
      return;
    }

    const uiRequest = ExtensionUiRequestSchema.safeParse(json);
    if (uiRequest.success) {
      if (isDialogRequest(uiRequest.data)) {
        this.trackDialog(uiRequest.data);
        this.armDialogTimeout(uiRequest.data.id);
      } else {
        this.recordPresentation(uiRequest.data);
      }
      this.publish({ type: "extension_ui_request", request: uiRequest.data });
      return;
    }

    const event = AgentEventSchema.safeParse(json);
    if (!event.success) {
      const type = (json as { type?: unknown })?.type;
      console.warn(`[pi-host] dropping unrecognised event ${String(type)} on session ${this.id}`);
      return;
    }
    this.observeAgentEvent(event.data);
    this.publish({ type: "agent_event", event: event.data });
  }

  private settle(response: RpcResponse): void {
    if (!response.id) return;
    const waiter = this.pending.get(response.id);
    if (!waiter) return;
    this.pending.delete(response.id);
    clearTimeout(waiter.timer);
    waiter.resolve(response);
  }

  private request(command: Record<string, unknown>, timeoutMs?: number): Promise<RpcResponse> {
    const proc = this.proc;
    // A sleeping session answers commands; it just has to get up first. Only
    // a sleeping one: a crashed session belongs to the registry's recovery,
    // and two restarts racing each other is worse than one failed command.
    if (!proc && !this.disposed && this.status === "cold") {
      return this.wakeThen(command, timeoutMs);
    }
    if (!proc || this.disposed) {
      return Promise.resolve({
        type: "response",
        command: String(command.type),
        success: false,
        error: `session ${this.id} is not running`,
      });
    }
    const id = `${this.id}:${++this.seq}`;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve({
          type: "response",
          command: String(command.type),
          success: false,
          error: "timed out waiting for pi",
        });
      }, timeoutMs ?? this.options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS);
      this.pending.set(id, { resolve, timer });
      proc.stdin.write(encodeJsonl({ ...command, id }));
    });
  }

  private armDialogTimeout(id: string): void {
    this.clearDialogTimeout(id);
    const timer = setTimeout(() => {
      this.dialogTimers.delete(id);
      console.warn(`[pi-host] session ${this.id} cancelled unanswered dialog ${id}`);
      this.answerDialog({ type: "extension_ui_response", id, cancelled: true });
    }, this.options.dialogTimeoutMs ?? DEFAULT_DIALOG_TIMEOUT_MS);
    timer.unref?.();
    this.dialogTimers.set(id, timer);
  }

  private clearDialogTimeout(id: string): void {
    const timer = this.dialogTimers.get(id);
    if (!timer) return;
    clearTimeout(timer);
    this.dialogTimers.delete(id);
  }

  /** Fire and forget: pi answers a dialog by id, not with an RPC response. */
  answerDialog(response: ExtensionUiResponse): boolean {
    this.clearDialogTimeout(response.id);
    if (!this.closeDialog(response.id)) return false;
    this.proc?.stdin.write(encodeJsonl(response));
    return true;
  }

  private handleExit(code: number | null, signal: string | null): void {
    this.proc = null;
    // A restart replays nothing, so a dialog from the dead child is dead too.
    for (const id of [...this.dialogTimers.keys()]) this.clearDialogTimeout(id);
    this.clearDialogs();
    for (const [id, waiter] of this.pending) {
      clearTimeout(waiter.timer);
      waiter.resolve({
        type: "response",
        command: "unknown",
        success: false,
        error: `pi exited (code ${code}, signal ${signal})`,
      });
      this.pending.delete(id);
    }
    if (this.disposed) return;
    this.setStatus("crashed");
    this.onExit?.({ code, signal });
  }

  async prompt(text: string, options: PromptOptions = {}): Promise<PromptResult> {
    this.noteActivity();
    // pi itself rejects a bare prompt while streaming, so the behaviour is
    // forwarded as given rather than second-guessed here.
    return toResult(
      await this.request({
        type: "prompt",
        message: text,
        images: options.images,
        streamingBehavior: options.streamingBehavior,
      }),
    );
  }

  /**
   * RPC mode has no command for pi's model scope, so the scope is read from
   * pi's own settings and applied to the catalogue here. Read per call, so an
   * edit to the settings does not need a daemon restart.
   */
  async listModels(options: { all?: boolean } = {}): Promise<ModelListing> {
    const response = await this.request({ type: "get_available_models" });
    if (!response.success) throw new Error(response.error ?? "get_available_models failed");
    const catalogue = (response.data as { models?: RpcModel[] } | undefined)?.models ?? [];
    const patterns = this.scopePatterns();
    const models = catalogue
      .map((model) => toModelOption(model))
      .filter((model): model is ModelOption => Boolean(model))
      .map((model) => ({ ...model, scoped: inScope(model, patterns) }));

    const scoped = models.filter((model) => model.scoped);
    // An empty scope is reported as the full catalogue rather than as an empty
    // list, so a client never shows nothing and calls it a scope.
    if (!options.all && scoped.length > 0) return { models: scoped, all: false };
    return { models, all: true };
  }

  async listCommands(): Promise<CommandOption[]> {
    const response = await this.request({ type: "get_commands" });
    if (!response.success) throw new Error(response.error ?? "get_commands failed");
    const commands = (response.data as { commands?: RpcSlashCommand[] } | undefined)?.commands ?? [];
    return commands.filter((command) => command?.name).map(toCommandOption);
  }

  async getStats(): Promise<SessionStats> {
    const response = await this.request({ type: "get_session_stats" });
    if (!response.success) throw new Error(response.error ?? "get_session_stats failed");
    // Loose parse: pi adds counters over time, and an unknown one is not a
    // reason to deny the client the ones it does understand.
    return SessionStatsSchema.parse(response.data ?? {});
  }

  private scopePatterns(): string[] {
    try {
      return (
        SettingsManager.create(this.createOptions.cwd, this.options.agentDir).getEnabledModels() ??
        []
      );
    } catch {
      return [];
    }
  }

  async setModel(provider: string, modelId: string): Promise<void> {
    const response = await this.request({ type: "set_model", provider, modelId });
    if (!response.success) throw new Error(response.error ?? "set_model failed");
    this.recordModel(toModelOption(response.data as RpcModel | undefined));
    // A new model can offer different levels, and pi clamps the active one to
    // what it supports, so both are re-read rather than assumed unchanged.
    await this.refreshThinking();
  }

  async setThinkingLevel(level: string): Promise<void> {
    const response = await this.request({ type: "set_thinking_level", level });
    if (!response.success) throw new Error(response.error ?? "set_thinking_level failed");
    await this.refreshThinking(level);
  }

  async setName(name: string): Promise<void> {
    const response = await this.request({ type: "set_session_name", name });
    if (!response.success) throw new Error(response.error ?? "set_session_name failed");
    this.recordName(name.trim());
  }

  async compact(customInstructions?: string): Promise<void> {
    this.noteActivity();
    // pi answers only once the summary is written, which takes as long as a
    // turn. Start and end arrive as events; the answer only carries failure.
    const done = this.request({ type: "compact", customInstructions }, COMPACT_TIMEOUT_MS);
    void done.catch(() => {});
  }

  async setAutoCompaction(enabled: boolean): Promise<void> {
    const response = await this.request({ type: "set_auto_compaction", enabled });
    if (!response.success) throw new Error(response.error ?? "set_auto_compaction failed");
    this.recordAutoCompaction(enabled);
  }

  /** Re-reads the level from pi when the caller does not already know it. */
  private async refreshThinking(level?: string): Promise<void> {
    const [levels, state] = await Promise.all([
      this.request({ type: "get_available_thinking_levels" }),
      level === undefined ? this.request({ type: "get_state" }) : undefined,
    ]);
    const available = levels.success
      ? ThinkingLevelsDataSchema.safeParse(levels.data).data?.levels
      : undefined;
    const current =
      level ??
      (state?.success ? SessionStateSchema.safeParse(state.data).data?.thinkingLevel : undefined);
    this.recordThinking(current, available);
  }

  async steer(text: string, images?: ImageContent[]): Promise<PromptResult> {
    this.noteActivity();
    return toResult(await this.request({ type: "steer", message: text, images }));
  }

  async followUp(text: string, images?: ImageContent[]): Promise<PromptResult> {
    this.noteActivity();
    return toResult(await this.request({ type: "follow_up", message: text, images }));
  }

  async getEntries(since?: string): Promise<EntriesPage> {
    return this.entriesFromFile(since) ?? this.entriesFromPi(since);
  }

  /**
   * pi persists an entry before announcing it, so its file answers the same
   * question without the whole session crossing stdout as one record, which
   * image-heavy sessions push past what the framer will hold.
   */
  private entriesFromFile(since?: string): EntriesPage | null {
    const transcript = this.sessionFile ? readTranscript(this.sessionFile) : null;
    if (!transcript) return null;
    const window = sliceEntries(transcript.entries, transcript.leafId, { since });
    this.setLeafId(window.leafId);
    if (!since) this.observeEntries(window.entries);
    return { entries: window.entries, leafId: window.leafId, reset: window.reset };
  }

  private async entriesFromPi(since?: string): Promise<EntriesPage> {
    const response = await this.request({ type: "get_entries", since });
    if (response.success) {
      const data = GetEntriesDataSchema.parse(response.data);
      this.setLeafId(data.leafId);
      if (!since) this.observeEntries(data.entries);
      return { entries: data.entries, leafId: data.leafId, reset: false };
    }
    if (isUnknownCursorError(response)) {
      // The cursor is gone, so the client's cache is worthless. Take the whole
      // session and tell it to start over.
      const full = await this.entriesFromPi();
      return { ...full, reset: true };
    }
    throw new Error(response.error ?? "get_entries failed");
  }

  async interrupt(): Promise<void> {
    await this.request({ type: "abort" });
    this.setStatus("idle");
  }

  async runBash(command: string, options: { excludeFromContext?: boolean } = {}): Promise<BashResult> {
    const exclude = options.excludeFromContext ?? false;
    return this.withBash(command, exclude, async () => {
      const response = await this.request(
        { type: "bash", command, excludeFromContext: exclude },
        this.options.bashTimeoutMs ?? DEFAULT_BASH_TIMEOUT_MS,
      );
      if (!response.success) throw new Error(response.error ?? "bash failed");
      return BashResultSchema.parse(response.data ?? {});
    });
  }

  async abortBash(): Promise<void> {
    await this.request({ type: "abort_bash" });
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    for (const id of [...this.dialogTimers.keys()]) this.clearDialogTimeout(id);
    this.clearDialogs();
    const proc = this.proc;
    this.proc = null;
    this.setStatus("disposed");
    this.clearListeners();
    if (proc) await this.stopChild(proc);
  }

  /**
   * Stops a child for good, escalating to SIGKILL.
   *
   * pi exits on SIGTERM only once its runtime has disposed, and a dispose that
   * never settles leaves it running forever with nobody holding its handle.
   */
  private async stopChild(proc: ChildProcessWithoutNullStreams): Promise<void> {
    // Detached from recovery first: this exit is intended, not a crash.
    proc.removeAllListeners("exit");
    if (proc.exitCode !== null || proc.signalCode !== null) return;
    const exited = new Promise<void>((done) => proc.once("exit", () => done()));
    const killer = setTimeout(
      () => proc.kill("SIGKILL"),
      this.options.killGraceMs ?? DEFAULT_KILL_GRACE_MS,
    );
    proc.stdin.end();
    proc.kill("SIGTERM");
    await exited;
    clearTimeout(killer);
  }

  /** True while a child process is backing this session. */
  get awake(): boolean {
    return this.proc !== null;
  }

  /**
   * Stops the child while keeping the session.
   *
   * The transcript is on disk and the id outlives the process, so a sleeping
   * session is still listable, still readable, and wakes on the next command.
   * Anything in flight would be lost, so the caller decides when it is safe.
   */
  async sleep(): Promise<void> {
    const proc = this.proc;
    if (this.disposed || !proc) return;
    this.proc = null;
    this.setStatus("cold");
    await this.stopChild(proc);
  }

  /**
   * Brings the child back for a session that was asleep or died.
   *
   * The ring buffer's seq numbers only ever meant anything within one process,
   * so waking announces itself the way a crash recovery does, with the durable
   * leaf the new child loaded.
   */
  async wake(): Promise<void> {
    if (this.disposed || this.proc) return;
    this.setStatus("starting");
    await this.relaunch("session resumed");
  }

  private async wakeThen(
    command: Record<string, unknown>,
    timeoutMs?: number,
  ): Promise<RpcResponse> {
    try {
      await this.wake();
    } catch (error) {
      return {
        type: "response",
        command: String(command.type),
        success: false,
        error: messageOf(error),
      };
    }
    return this.request(command, timeoutMs);
  }

  /** Respawns on the same session id, so pi reloads the persisted JSONL. */
  async restart(reason: string): Promise<void> {
    if (this.disposed) return;
    this.setStatus("crashed");
    await this.relaunch(reason);
  }

  /**
   * Reloads project trust without forking the conversation.
   *
   * pi decides trust from its launch flags, so the child has to be replaced.
   * It is replaced on the same session id, so the transcript is the same file
   * and clients keep their cursor instead of being moved to a new session.
   */
  async setProjectTrust(trustProject: boolean): Promise<void> {
    if (this.disposed || this.trusted === trustProject) return;
    this.createOptions.trustProject = trustProject;
    this.setTrusted(trustProject);
    await this.replaceChild(trustProject ? "directory trusted" : "trust revoked");
  }

  /** RPC mode has no reload command; a fresh child reads everything again. */
  async reload(): Promise<void> {
    if (this.disposed) throw new Error(`session ${this.id} is not running`);
    this.assertReloadable();
    await this.replaceChild("reloaded");
  }

  async exportHtml(outputPath?: string): Promise<string> {
    const response = await this.request({ type: "export_html", outputPath });
    if (!response.success) throw new Error(response.error ?? "export_html failed");
    const path = (response.data as { path?: string } | undefined)?.path;
    if (!path) throw new Error("export_html returned no path");
    // pi answers relative to its own working directory, which is the cwd.
    return resolvePath(this.createOptions.cwd, path);
  }

  private async replaceChild(reason: string): Promise<void> {
    const proc = this.proc;
    this.proc = null;
    // Two children on one session file would interleave their writes.
    if (proc) await this.stopChild(proc);
    this.setStatus("starting");
    await this.relaunch(reason);
  }

  private async relaunch(reason: string): Promise<void> {
    this.resetPresentation();
    await this.spawnChild();
    this.publish({ type: "session_recovered", leafId: this.leafId, reason });
  }
}

/** The fields of pi's `Model` payload that reach a client. */
interface RpcModel {
  id?: string;
  name?: string;
  provider?: string;
}

const THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high"]);

/**
 * Whether a model is inside pi's `enabledModels` scope.
 *
 * Patterns are `provider/id` or a bare id, optionally suffixed with a thinking
 * level, and may name an alias whose concrete id is dated, so a pattern also
 * matches an id that starts with it.
 */
function inScope(model: ModelOption, patterns: string[]): boolean {
  return patterns.some((raw) => {
    const [head, ...rest] = raw.split(":");
    const last = rest.at(-1);
    const pattern = last && THINKING_LEVELS.has(last) ? [head, ...rest.slice(0, -1)].join(":") : raw;
    const [provider, id] = pattern.includes("/")
      ? [pattern.slice(0, pattern.indexOf("/")), pattern.slice(pattern.indexOf("/") + 1)]
      : [model.provider, pattern];
    return provider === model.provider && model.modelId.startsWith(id);
  });
}

function toModelOption(model: RpcModel | undefined): ModelOption | undefined {
  if (!model?.id || !model.provider) return undefined;
  return { provider: model.provider, modelId: model.id, name: model.name ?? model.id, scoped: false };
}

interface RpcSlashCommand {
  name: string;
  description?: string;
  source?: "extension" | "prompt" | "skill";
  /** Current pi. Older builds sent `location` and `path` at the top level. */
  sourceInfo?: { path?: string; scope?: string };
  location?: string;
  path?: string;
}

function toCommandOption(command: RpcSlashCommand): CommandOption {
  return {
    name: command.name,
    description: command.description,
    source: command.source,
    scope: command.sourceInfo?.scope ?? command.location,
    path: command.sourceInfo?.path ?? command.path,
  };
}

function toResult(response: RpcResponse): PromptResult {
  return response.success
    ? { accepted: true }
    : { accepted: false, error: response.error ?? "command rejected" };
}
