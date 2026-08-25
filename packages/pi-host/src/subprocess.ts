import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { ImageContent } from "@pios/protocol";
import {
  AgentEventSchema,
  ExtensionUiRequestSchema,
  GetEntriesDataSchema,
  RpcResponseSchema,
  isUnknownCursorError,
  type RpcResponse,
} from "@pios/protocol";
import { JsonlFramer, encodeJsonl } from "@pios/protocol/jsonl";
import { BaseSession } from "./base-session.ts";
import type {
  CreateSessionOptions,
  EntriesPage,
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
  sessionDir?: string;
  env?: NodeJS.ProcessEnv;
  requestTimeoutMs?: number;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 120_000;

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
    const args = ["--mode", "rpc", "--session-id", this.id];
    if (this.options.sessionDir) args.push("--session-dir", this.options.sessionDir);
    // Always explicit. pi's headless trust default depends on machine state,
    // and a session that silently loses project extensions is worse than one
    // that reports being untrusted.
    args.push(this.createOptions.trustProject ? "--approve" : "--no-approve");
    if (this.createOptions.model) args.push("--model", this.createOptions.model);
    if (this.createOptions.name) args.push("--name", this.createOptions.name);
    return [...(this.options.argsPrefix ?? []), ...args, ...(this.options.extraArgs ?? [])];
  }

  private async spawnChild(): Promise<void> {
    this.framer = new JsonlFramer();
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
      const data = state.data as { sessionFile?: string; isStreaming?: boolean } | undefined;
      this.sessionFile = data?.sessionFile;
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
    let json: unknown;
    try {
      json = JSON.parse(record);
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

  private request(command: Record<string, unknown>): Promise<RpcResponse> {
    const proc = this.proc;
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
      }, this.options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS);
      this.pending.set(id, { resolve, timer });
      proc.stdin.write(encodeJsonl({ ...command, id }));
    });
  }

  private handleExit(code: number | null, signal: string | null): void {
    this.proc = null;
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

  async steer(text: string, images?: ImageContent[]): Promise<PromptResult> {
    return toResult(await this.request({ type: "steer", message: text, images }));
  }

  async followUp(text: string, images?: ImageContent[]): Promise<PromptResult> {
    return toResult(await this.request({ type: "follow_up", message: text, images }));
  }

  async getEntries(since?: string): Promise<EntriesPage> {
    const response = await this.request({ type: "get_entries", since });
    if (response.success) {
      const data = GetEntriesDataSchema.parse(response.data);
      this.setLeafId(data.leafId);
      return { entries: data.entries, leafId: data.leafId, reset: false };
    }
    if (isUnknownCursorError(response)) {
      // The cursor is gone, so the client's cache is worthless. Take the whole
      // session and tell it to start over.
      const full = await this.getEntries();
      return { ...full, reset: true };
    }
    throw new Error(response.error ?? "get_entries failed");
  }

  async interrupt(): Promise<void> {
    await this.request({ type: "abort" });
    this.setStatus("idle");
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    const proc = this.proc;
    this.proc = null;
    if (proc) {
      proc.stdin.end();
      proc.kill("SIGTERM");
    }
    this.setStatus("disposed");
    this.clearListeners();
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
    const proc = this.proc;
    this.proc = null;
    if (proc) {
      // Detached from recovery first: this exit is intended, not a crash.
      proc.removeAllListeners("exit");
      proc.stdin.end();
      proc.kill("SIGTERM");
    }
    this.setStatus("starting");
    await this.relaunch(trustProject ? "directory trusted" : "trust revoked");
  }

  private async relaunch(reason: string): Promise<void> {
    await this.spawnChild();
    this.publish({ type: "session_recovered", leafId: this.leafId, reason });
  }
}

function toResult(response: RpcResponse): PromptResult {
  return response.success
    ? { accepted: true }
    : { accepted: false, error: response.error ?? "command rejected" };
}
