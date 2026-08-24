/**
 * A stub that speaks pi's RPC protocol.
 *
 * The contract tests need a subprocess that streams deltas, persists entries,
 * rejects unknown cursors, and can be told to die on demand. Using real pi
 * would make them slow, non-deterministic, and dependent on an API key.
 *
 * Behaviour is pinned to what the Phase 0 traces actually showed.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { JsonlFramer, encodeJsonl } from "@pios/protocol/jsonl";

const argv = process.argv.slice(2);
const arg = (name: string) => {
  const i = argv.indexOf(name);
  return i === -1 ? undefined : argv[i + 1];
};

const sessionId = arg("--session-id") ?? "fake";
const sessionDir = arg("--session-dir") ?? ".";
const trusted = argv.includes("--approve");
mkdirSync(sessionDir, { recursive: true });
const statePath = `${sessionDir}/${sessionId}.json`;

interface Entry {
  id: string;
  parentId: string | null;
  type: string;
  message: unknown;
}

let entries: Entry[] = [];
try {
  entries = JSON.parse(readFileSync(statePath, "utf8"));
} catch {
  entries = [];
}

let counter = entries.length;
let streaming = false;
let aborted = false;

const write = (value: unknown) => process.stdout.write(encodeJsonl(value));
const persist = () => writeFileSync(statePath, JSON.stringify(entries));
const leafId = () => entries.at(-1)?.id ?? null;

function addEntry(message: unknown): Entry {
  const entry: Entry = {
    id: `${sessionId.slice(0, 4)}-${++counter}`,
    parentId: leafId(),
    type: "message",
    message,
  };
  entries.push(entry);
  persist();
  return entry;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function runTurn(text: string) {
  streaming = true;
  aborted = false;
  const user = { role: "user", content: text, timestamp: Date.now() };
  addEntry(user);
  write({ type: "agent_start" });
  write({ type: "turn_start" });
  write({ type: "message_start", message: user });
  write({ type: "message_end", message: user });

  const reply = `echo: ${text}`;
  write({ type: "message_start", message: { role: "assistant", content: [] } });
  write({
    type: "message_update",
    assistantMessageEvent: { type: "text_start", contentIndex: 0 },
  });
  for (const chunk of reply.match(/.{1,4}/gs) ?? []) {
    if (aborted) break;
    await sleep(2);
    write({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: chunk },
    });
    // Dying mid-stream is how the crash tests exercise recovery.
    if (text.includes("CRASH_MIDSTREAM")) process.exit(9);
  }
  write({
    type: "message_update",
    assistantMessageEvent: { type: "text_end", contentIndex: 0, content: reply },
  });

  const assistant = { role: "assistant", content: [{ type: "text", text: reply }] };
  write({ type: "message_end", message: assistant });
  addEntry(assistant);
  write({ type: "turn_end", message: assistant, toolResults: [] });
  write({ type: "agent_end", messages: [], willRetry: false });
  streaming = false;
  write({ type: "agent_settled" });
}

let queue: Promise<void> = Promise.resolve();

function handle(command: Record<string, any>) {
  const respond = (extra: Record<string, unknown>) =>
    write({ type: "response", command: command.type, id: command.id, ...extra });

  switch (command.type) {
    case "get_state":
      return respond({
        success: true,
        data: { isStreaming: streaming, sessionFile: statePath, sessionId, trusted },
      });

    case "get_entries": {
      if (command.since === undefined) {
        return respond({ success: true, data: { entries, leafId: leafId() } });
      }
      const index = entries.findIndex((e) => e.id === command.since);
      if (index === -1) {
        return respond({ success: false, error: `Entry not found: ${command.since}` });
      }
      return respond({
        success: true,
        data: { entries: entries.slice(index + 1), leafId: leafId() },
      });
    }

    case "prompt": {
      if (streaming && !command.streamingBehavior) {
        return respond({
          success: false,
          error:
            "Agent is already processing. Specify streamingBehavior ('steer' or 'followUp') to queue the message.",
        });
      }
      if (command.message === "CRASH_NOW") process.exit(7);
      respond({ success: true });
      queue = queue.then(() => runTurn(command.message));
      return;
    }

    case "steer":
    case "follow_up":
      respond({ success: true });
      write({
        type: "queue_update",
        steering: command.type === "steer" ? [command.message] : [],
        followUp: command.type === "follow_up" ? [command.message] : [],
      });
      return;

    case "abort":
      aborted = true;
      return respond({ success: true });

    default:
      return respond({ success: false, error: `unsupported command: ${command.type}` });
  }
}

const framer = new JsonlFramer();
process.stdin.on("data", (chunk) => {
  for (const record of framer.push(chunk)) {
    try {
      handle(JSON.parse(record));
    } catch (error) {
      write({ type: "response", command: "parse", success: false, error: String(error) });
    }
  }
});
process.stdin.on("end", () => process.exit(0));
