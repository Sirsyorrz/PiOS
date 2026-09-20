import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { JsonlFramer } from "../src/jsonl.ts";
import { parseRpcOutbound } from "../src/parse.ts";
import { MessageAssembler, TranscriptAssembler } from "../src/assembler.ts";
import type { AgentEvent } from "../src/events.ts";
import type { AgentMessage, AssistantMessage } from "../src/messages.ts";
import { GetEntriesDataSchema, isUnknownCursorError, type RpcResponse } from "../src/commands.ts";

const TRACE_DIR = fileURLToPath(new URL("../../../spikes/traces/", import.meta.url));
const traces = readdirSync(TRACE_DIR).filter((f) => f.endsWith(".jsonl"));

assert.ok(traces.length > 0, "no fixtures found");

/** Replays a recorded trace exactly as a live client would read it. */
function readTrace(name: string) {
  const framer = new JsonlFramer();
  const bytes = readFileSync(`${TRACE_DIR}${name}`);
  const records: string[] = [];
  // Feed in small chunks so records land on arbitrary boundaries.
  for (let i = 0; i < bytes.length; i += 7) {
    records.push(...framer.push(bytes.subarray(i, i + 7)));
  }
  records.push(...framer.end());

  const events: AgentEvent[] = [];
  const responses: RpcResponse[] = [];
  for (const record of records) {
    const parsed = parseRpcOutbound(record);
    assert.ok(parsed.ok, `unparsed record in ${name}: ${parsed.ok ? "" : parsed.error}`);
    const value = parsed.value;
    if (value.type === "response") responses.push(value);
    else if (value.type !== "extension_ui_request") events.push(value as AgentEvent);
  }
  assert.ok(records.length > 0, `${name} is empty`);
  return { events, responses, records };
}

function hasAssistantEnd(events: AgentEvent[]): boolean {
  return events.some((e) => e.type === "message_end" && e.message.role === "assistant");
}

for (const name of traces) {
  test(`${name}: every record parses`, () => {
    const { records } = readTrace(name);
    assert.ok(records.length > 0);
  });

  test(`${name}: transcript reproduces the message_end sequence`, () => {
    const { events } = readTrace(name);
    const assembler = new TranscriptAssembler();
    for (const event of events) assembler.apply(event);

    const expected = events
      .filter((e): e is Extract<AgentEvent, { type: "message_end" }> => e.type === "message_end")
      .map((e) => e.message);

    const actual = assembler.snapshot().messages;
    assert.deepEqual(actual, expected);
  });

  test(`${name}: delta assembly matches message_end exactly`, { skip: !hasAssistantEnd(readTrace(name).events) && "no completed assistant message in this trace" }, () => {
    const { events } = readTrace(name);
    let current: MessageAssembler | null = null;
    let compared = 0;

    for (const event of events) {
      if (event.type === "message_start" && event.message.role === "assistant") {
        current = new MessageAssembler();
      } else if (event.type === "message_update") {
        current ??= new MessageAssembler();
        current.applyDelta(event.assistantMessageEvent);
      } else if (event.type === "message_end" && event.message.role === "assistant") {
        if (current) {
          assertMatches(current, event.message, `${name} message ${compared}`);
          compared++;
        }
        current = null;
      }
    }
    assert.ok(compared > 0, "no assistant messages compared");
  });
}

test("system-message.jsonl: pi's assembled prompt is a transcript message", () => {
  const { events } = readTrace("system-message.jsonl");
  const system = events.filter(
    (e) => e.type === "message_end" && e.message.role === "system",
  );
  assert.equal(system.length, 1);
});

test("crash.jsonl leaves an unterminated assistant message streaming", () => {
  // The trace stops mid-delta because the process was SIGKILLed.
  const { events } = readTrace("crash.jsonl");
  const assembler = new TranscriptAssembler();
  for (const event of events) assembler.apply(event);

  const snapshot = assembler.snapshot();
  assert.ok(snapshot.streaming, "expected a partial message");
  assert.equal(snapshot.streaming.final, null);
  assert.ok(snapshot.streaming.content.length > 0);
  // agent_settled never arrived, so the run is still open.
  assert.equal(snapshot.running, true);
});

test("resume.jsonl: the cursor delta and the unknown-cursor rejection", () => {
  const { responses } = readTrace("resume.jsonl");
  const entries = responses.filter((r) => r.command === "get_entries");
  assert.ok(entries.length >= 2);

  const delta = GetEntriesDataSchema.parse(entries[0]!.data);
  assert.ok(delta.entries.length > 0);
  assert.equal(delta.leafId, delta.entries.at(-1)!.id, "leafId is the last entry of the delta");

  const rejected = entries.find((r) => !r.success);
  assert.ok(rejected, "expected a rejected cursor in the trace");
  assert.ok(isUnknownCursorError(rejected));
});

test("streaming.jsonl records the steering queue", () => {
  const { events } = readTrace("streaming.jsonl");
  const queues = events.filter((e) => e.type === "queue_update");
  assert.ok(queues.length > 0);

  const assembler = new TranscriptAssembler();
  for (const event of events) assembler.apply(event);
  // The queue drains before the last agent_settled.
  assert.deepEqual(assembler.snapshot().queue, { steering: [], followUp: [] });
  assert.equal(assembler.snapshot().running, false);
});

test("prompt-basic.jsonl correlates tool execution by toolCallId", () => {
  const { events } = readTrace("prompt-basic.jsonl");
  const assembler = new TranscriptAssembler();
  for (const event of events) assembler.apply(event);

  const tools = assembler.snapshot().toolExecutions;
  assert.equal(tools.length, 1);
  assert.equal(tools[0]!.toolName, "read");
  assert.equal(tools[0]!.status, "done");
  assert.equal(tools[0]!.isError, false);

  // The tool call id appears only on toolcall_end, never on the deltas, so the
  // streamed block and the execution event must still line up.
  const toolCallIds = events
    .filter((e) => e.type === "message_update")
    .map((e) => e.assistantMessageEvent)
    .filter((d) => d.type === "toolcall_end")
    .map((d) => d.toolCall.id);
  assert.deepEqual(toolCallIds, [tools[0]!.toolCallId]);
});

function assertMatches(assembler: MessageAssembler, final: AgentMessage, label: string) {
  const message = final as AssistantMessage;
  const blocks = assembler.snapshot().content;

  const assembledText = blocks
    .filter((b) => b.type === "text")
    .map((b) => (b.type === "text" ? b.text : ""))
    .join("");
  const finalText = message.content
    .filter((c) => c.type === "text")
    .map((c) => (c as { text: string }).text)
    .join("");
  assert.equal(assembledText, finalText, `${label}: text`);

  const assembledThinking = blocks
    .filter((b) => b.type === "thinking")
    .map((b) => (b.type === "thinking" ? b.thinking : ""))
    .join("");
  const finalThinking = message.content
    .filter((c) => c.type === "thinking")
    .map((c) => (c as { thinking: string }).thinking)
    .join("");
  assert.equal(assembledThinking, finalThinking, `${label}: thinking`);

  const assembledCalls = blocks
    .filter((b) => b.type === "toolCall")
    .map((b) => (b.type === "toolCall" ? { id: b.id, name: b.name, arguments: b.arguments } : null));
  const finalCalls = message.content
    .filter((c) => c.type === "toolCall")
    .map((c) => {
      const call = c as { id: string; name: string; arguments: unknown };
      return { id: call.id, name: call.name, arguments: call.arguments };
    });
  assert.deepEqual(assembledCalls, finalCalls, `${label}: tool calls`);
}
