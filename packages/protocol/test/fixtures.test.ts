import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { JsonlFramer } from "../src/jsonl.ts";
import { parseRpcOutbound } from "../src/parse.ts";
import { MessageAssembler, TranscriptAssembler } from "../src/assembler.ts";
import { slimEvent } from "../src/slim.ts";
import type { AgentEvent } from "../src/events.ts";
import { turnFailure, type AgentMessage, type AssistantMessage } from "../src/messages.ts";
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
  test(`${name}: a slimmed stream rebuilds the same transcript`, () => {
    const { events } = readTrace(name);
    const full = new TranscriptAssembler();
    const slim = new TranscriptAssembler();
    for (const event of events) {
      full.apply(structuredClone(event));
      slim.apply(slimEvent(structuredClone(event)));
    }
    assert.deepEqual(slim.snapshot(), full.snapshot());
    // Every message is still on the wire exactly once, on its message_end.
    const slimmed = events.map(slimEvent);
    for (const event of slimmed) {
      if (event.type === "agent_end") assert.deepEqual(event.messages ?? [], []);
      if (event.type === "turn_end") assert.equal(event.toolResults, undefined);
    }
  });

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

test("rate-limit.jsonl: every attempt is kept, and the retry ends in failure", () => {
  const { events, responses } = readTrace("rate-limit.jsonl");
  const assembler = new TranscriptAssembler();
  const retries: (number | null)[] = [];
  for (const event of events) {
    assembler.apply(event);
    retries.push(assembler.snapshot().status.retry?.attempt ?? null);
  }
  assert.deepEqual([...new Set(retries.filter((r) => r !== null))], [1, 2]);

  const snapshot = assembler.snapshot();
  assert.equal(snapshot.running, false);
  assert.equal(snapshot.status.retry, null);
  const failed = snapshot.messages.filter((m) => turnFailure(m) !== null);
  assert.equal(failed.length, 3);
  assert.equal(turnFailure(failed[0]!), "429: Rate limit reached for requests");

  const end = events.find((e) => e.type === "auto_retry_end");
  assert.ok(end && end.type === "auto_retry_end" && !end.success && end.finalError);

  // History keeps the failed attempts too, so a resync shows the same thing.
  const entries = GetEntriesDataSchema.parse(responses.find((r) => r.command === "get_entries")!.data);
  const persisted = entries.entries.flatMap((e) => (e.message ? [e.message] : []));
  assert.equal(persisted.filter((m) => turnFailure(m) !== null).length, 3);
});

test("rate-limit-abort.jsonl: abort_retry ends the retry and settles the run", () => {
  const { events } = readTrace("rate-limit-abort.jsonl");
  const assembler = new TranscriptAssembler();
  for (const event of events) assembler.apply(event);
  const end = events.find((e) => e.type === "auto_retry_end");
  assert.ok(end && end.type === "auto_retry_end");
  assert.equal(end.finalError, "Retry cancelled");
  assert.equal(assembler.snapshot().status.retry, null);
  assert.equal(assembler.snapshot().running, false);
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

test("slimming drops the in-process host's whole-message copies from a delta", () => {
  const partial = { role: "assistant", content: [{ type: "text", text: "hello" }] };
  const event = {
    type: "message_update",
    message: partial,
    assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "lo", partial },
  } as unknown as AgentEvent;
  assert.deepEqual(slimEvent(event), {
    type: "message_update",
    assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "lo" },
  });
});

test("slimming leaves a tool result's own events whole", () => {
  const image = { type: "image", mimeType: "image/png", data: "AAAA" };
  const result = { role: "toolResult", toolCallId: "t1", toolName: "read", content: [image], isError: false };
  const end = { type: "message_end", message: result } as unknown as AgentEvent;
  const tool = {
    type: "tool_execution_end",
    toolCallId: "t1",
    toolName: "read",
    result: { content: [image] },
    isError: false,
  } as unknown as AgentEvent;
  assert.equal(slimEvent(end), end);
  assert.equal(slimEvent(tool), tool);
  const start = slimEvent({ type: "message_start", message: result } as unknown as AgentEvent);
  assert.deepEqual(start, { type: "message_start", message: { ...result, content: [] } });
});
