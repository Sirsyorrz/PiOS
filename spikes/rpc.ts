import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { JsonlFramer } from "./jsonl.ts";

export type Json = Record<string, any>;

/**
 * Minimal subprocess RPC client for the spikes. Not the real transport; it
 * exists to prove the contract, so it stays dependency-free and disposable.
 */
export class RpcProbe {
  private readonly proc: ChildProcessWithoutNullStreams;
  private readonly framer = new JsonlFramer();
  private readonly waiters = new Map<string, (r: Json) => void>();
  private readonly listeners = new Set<(e: Json) => void>();
  private seq = 0;
  exited: Promise<number | null>;
  stderr = "";

  constructor(
    args: string[],
    private readonly tracePath?: string,
    opts: { cwd?: string } = {},
  ) {
    if (tracePath) mkdirSync(dirname(tracePath), { recursive: true });
    this.proc = spawn("pi", ["--mode", "rpc", ...args], {
      cwd: opts.cwd ?? process.cwd(),
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.proc.stdout.on("data", (c) => {
      for (const line of this.framer.push(c)) this.onLine(line);
    });
    this.proc.stderr.on("data", (c) => (this.stderr += String(c)));
    this.exited = new Promise((res) => this.proc.on("exit", (code) => res(code)));
  }

  private onLine(line: string) {
    if (!line.trim()) return;
    if (this.tracePath) appendFileSync(this.tracePath, line + "\n");
    let msg: Json;
    try {
      msg = JSON.parse(line);
    } catch (err) {
      console.error("unparseable line:", line.slice(0, 200), err);
      return;
    }
    if (msg.type === "response" && typeof msg.id === "string") {
      const w = this.waiters.get(msg.id);
      if (w) {
        this.waiters.delete(msg.id);
        w(msg);
        return;
      }
    }
    for (const l of this.listeners) l(msg);
  }

  on(fn: (e: Json) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Await a specific event type. */
  next(type: string, timeoutMs = 120_000): Promise<Json> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        off();
        reject(new Error(`timeout waiting for ${type}`));
      }, timeoutMs);
      const off = this.on((e) => {
        if (e.type !== type) return;
        clearTimeout(timer);
        off();
        resolve(e);
      });
    });
  }

  send(cmd: Json): Promise<Json> {
    const id = `req-${++this.seq}`;
    const payload = JSON.stringify({ ...cmd, id }) + "\n";
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters.delete(id);
        reject(new Error(`timeout on ${cmd.type}`));
      }, 120_000);
      this.waiters.set(id, (r) => {
        clearTimeout(timer);
        resolve(r);
      });
      this.proc.stdin.write(payload);
    });
  }

  /** Fire-and-forget: no response correlation, used for hard-kill tests. */
  write(cmd: Json) {
    this.proc.stdin.write(JSON.stringify(cmd) + "\n");
  }

  kill(signal: NodeJS.Signals = "SIGKILL") {
    this.proc.kill(signal);
  }
}
