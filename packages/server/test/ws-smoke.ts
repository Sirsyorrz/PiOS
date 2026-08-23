/**
 * Socket half of `smoke.sh`: prompt, disconnect, reconnect, resync.
 *
 * A separate file because websocat cannot express "drop the connection and
 * come back with a cursor", which is the only part worth testing here.
 */
import { WebSocket } from "ws";
import { WIRE_VERSION, type ServerFrame } from "@pios/protocol";

const url = process.env.PIOS_URL ?? "ws://127.0.0.1:4211/ws";
const token = process.env.PIOS_TOKEN ?? "";
const cwd = process.argv[2] ?? process.cwd();

class Client {
  private socket!: WebSocket;
  private seq = 0;
  readonly frames: ServerFrame[] = [];

  async connect(): Promise<ServerFrame> {
    this.socket = new WebSocket(url);
    await new Promise((resolve, reject) => {
      this.socket.once("open", resolve);
      this.socket.once("error", reject);
    });
    this.socket.on("message", (data) => this.frames.push(JSON.parse(String(data))));
    return this.send({ type: "hello", deviceToken: token, clientVersion: "smoke" });
  }

  send(body: Record<string, unknown>): Promise<ServerFrame> {
    const commandId = `smoke-${++this.seq}`;
    this.socket.send(JSON.stringify({ v: WIRE_VERSION, commandId, ...body }));
    return this.await((f) => f.commandId === commandId);
  }

  await(match: (f: ServerFrame) => boolean, timeoutMs = 120_000): Promise<ServerFrame> {
    return new Promise((resolve, reject) => {
      const started = Date.now();
      const tick = setInterval(() => {
        const found = this.frames.find(match);
        if (found) {
          clearInterval(tick);
          resolve(found);
        } else if (Date.now() - started > timeoutMs) {
          clearInterval(tick);
          reject(new Error("timed out"));
        }
      }, 25);
    });
  }

  close(): void {
    this.socket.close();
  }
}

const first = new Client();
const welcome = await first.connect();
console.log("welcome:", welcome.type);

const created = await first.send({ type: "create_session", cwd, trustProject: false });
if (created.type !== "session_state") throw new Error(`create failed: ${JSON.stringify(created)}`);
const sessionId = created.sessionId;
console.log("session:", sessionId);

await first.send({ type: "subscribe", sessionId });
console.log("subscribed");
await first.send({
  type: "prompt",
  sessionId,
  messageId: "smoke-m1",
  text: "Reply with the single word: pong",
  images: [],
});

console.log("prompt accepted, waiting for the agent to settle");
await first.await(
  (f) => f.type === "agent_event" && f.sessionId === sessionId && f.event.type === "agent_settled",
);
const before = await first.send({ type: "get_entries", sessionId });
if (before.type !== "entries") throw new Error("no entries");
console.log(`entries before disconnect: ${before.entries.length}, leaf=${before.leafId}`);

console.log("dropping the connection");
first.close();
await new Promise((r) => setTimeout(r, 500));

const second = new Client();
const welcomeBack = await second.connect();
if (welcomeBack.type !== "welcome") throw new Error("no welcome");
const summary = welcomeBack.sessions.find((s) => s.sessionId === sessionId);
console.log("session survived the disconnect:", summary?.status, "leaf:", summary?.leafId);

const delta = await second.send({ type: "get_entries", sessionId, since: before.leafId! });
if (delta.type !== "entries") throw new Error("resync failed");
console.log(`resync delta: ${delta.entries.length} entries, reset=${delta.reset}`);
if (delta.entries.length !== 0 || delta.reset) throw new Error("expected an empty delta");

const stale = await second.send({ type: "get_entries", sessionId, since: "bogus-id" });
if (stale.type !== "entries" || !stale.reset) throw new Error("expected a reset");
console.log(`unknown cursor -> reset with ${stale.entries.length} entries`);

await second.send({ type: "dispose_session", sessionId });
second.close();
console.log("socket smoke OK");
process.exit(0);
