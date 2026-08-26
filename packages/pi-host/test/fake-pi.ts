/**
 * A stub that speaks pi's RPC protocol.
 *
 * The contract tests need a subprocess that streams deltas, persists entries,
 * rejects unknown cursors, and can be told to die on demand. Using real pi
 * would make them slow, non-deterministic, and dependent on an API key.
 *
 * Behaviour is pinned to what the Phase 0 traces actually showed.
 */
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { JsonlFramer, encodeJsonl } from "@pios/protocol/jsonl";

const argv = process.argv.slice(2);
const arg = (name: string) => {
  const i = argv.indexOf(name);
  return i === -1 ? undefined : argv[i + 1];
};

// `--session <path>` binds to an exact file, `--session-id` looks one up.
const sessionPath = arg("--session");
const sessionDir = arg("--session-dir") ?? ".";
const sessionId = sessionPath
  ? sessionPath.split("/").pop()!.replace(/\.json$/, "")
  : arg("--session-id") ?? "fake";
const trusted = argv.includes("--approve");
mkdirSync(sessionDir, { recursive: true });
const statePath = sessionPath ?? `${sessionDir}/${sessionId}.json`;
// So tests can assert how the host launched pi, including on a relaunch.
appendFileSync(`${sessionDir}/argv.log`, `${argv.join(" ")}\n`);

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

// Mirrors pi: a dialog blocks the turn until the host answers by id, and no
// timer is armed unless the extension asked for one.
let answerDialog: ((response: Record<string, unknown>) => void) | null = null;
function askDialog(id: string): Promise<Record<string, unknown>> {
  write({ type: "extension_ui_request", id, method: "confirm", title: "Apply edit?" });
  return new Promise((resolve) => {
    answerDialog = resolve;
  });
}

async function runTurn(text: string) {
  streaming = true;
  aborted = false;
  const user = { role: "user", content: text, timestamp: Date.now() };
  addEntry(user);
  write({ type: "agent_start" });
  write({ type: "turn_start" });
  write({ type: "message_start", message: user });
  write({ type: "message_end", message: user });

  if (text.includes("SHOW_STATUS")) {
    // Extensions share pi's stdout and ring the terminal bell without a
    // newline, so a stray control byte rides along with the next record.
    process.stdout.write("\x07");
    write({
      type: "extension_ui_request",
      id: `${sessionId}-status`,
      method: "setStatus",
      statusKey: "nolo",
      statusText: "YOLO",
    });
    write({ type: "extension_ui_request", id: `${sessionId}-note`, method: "notify", message: "heads up" });
  }

  const answer = text.includes("ASK_DIALOG") ? await askDialog(`${sessionId}-dialog`) : null;
  const reply = answer ? `dialog: ${JSON.stringify(answer)}` : `echo: ${text}`;
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

const catalogue = [
  { id: "fast-1", name: "Fast 1", provider: "acme" },
  { id: "deep-1", name: "Deep 1", provider: "acme" },
  { id: "other-1", name: "Other 1", provider: "other" },
];
let model = catalogue[0];
// Only the "deep" model reasons, so tests can watch the level get clamped.
const levelsFor = (id: string | undefined) =>
  id === "deep-1" ? ["off", "low", "medium", "high"] : ["off"];
let thinkingLevel = "off";

let queue: Promise<void> = Promise.resolve();

function handle(command: Record<string, any>) {
  const respond = (extra: Record<string, unknown>) =>
    write({ type: "response", command: command.type, id: command.id, ...extra });

  switch (command.type) {
    case "extension_ui_response": {
      const resolve = answerDialog;
      answerDialog = null;
      resolve?.(command);
      return;
    }

    case "get_state":
      return respond({
        success: true,
        data: {
          isStreaming: streaming,
          sessionFile: statePath,
          sessionId,
          trusted,
          model,
          thinkingLevel,
        },
      });

    case "get_available_models":
      return respond({ success: true, data: { models: catalogue } });

    case "set_model": {
      const found = catalogue.find(
        (m) => m.provider === command.provider && m.id === command.modelId,
      );
      if (!found) return respond({ success: false, error: "Unknown model" });
      model = found;
      if (!levelsFor(model?.id).includes(thinkingLevel)) thinkingLevel = "off";
      return respond({ success: true, data: found });
    }

    case "get_available_thinking_levels":
      return respond({ success: true, data: { levels: levelsFor(model?.id) } });

    case "set_thinking_level": {
      if (!levelsFor(model?.id).includes(command.level)) {
        return respond({ success: false, error: "Unsupported thinking level" });
      }
      thinkingLevel = command.level;
      return respond({ success: true });
    }

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
