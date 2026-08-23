import { test } from "node:test";
import assert from "node:assert/strict";
import { MessageAssembler, TranscriptAssembler } from "../src/assembler.ts";
import type { AgentEvent, AssistantMessageEvent } from "../src/events.ts";

const delta = (e: AssistantMessageEvent): AgentEvent => ({
  type: "message_update",
  assistantMessageEvent: e,
});

test("text blocks are ordered by contentIndex, not arrival order", () => {
  const assembler = new MessageAssembler();
  assembler.applyDelta({ type: "text_start", contentIndex: 1 });
  assembler.applyDelta({ type: "text_delta", contentIndex: 1, delta: "second" });
  assembler.applyDelta({ type: "text_start", contentIndex: 0 });
  assembler.applyDelta({ type: "text_delta", contentIndex: 0, delta: "first " });
  assert.equal(assembler.text(), "first second");
});

test("_end content replaces the accumulated deltas", () => {
  const assembler = new MessageAssembler();
  assembler.applyDelta({ type: "text_start", contentIndex: 0 });
  assembler.applyDelta({ type: "text_delta", contentIndex: 0, delta: "par" });
  assembler.applyDelta({ type: "text_end", contentIndex: 0, content: "partial then whole" });
  assert.equal(assembler.text(), "partial then whole");
});

test("tool call args buffer by contentIndex; the id arrives only at the end", () => {
  const assembler = new MessageAssembler();
  assembler.applyDelta({ type: "toolcall_start", contentIndex: 0 });
  assembler.applyDelta({ type: "toolcall_delta", contentIndex: 0, delta: '{"path":' });

  const mid = assembler.snapshot().content[0];
  assert.equal(mid?.type, "toolCall");
  assert.equal(mid.type === "toolCall" && mid.id, null);
  assert.equal(mid.type === "toolCall" && mid.argsText, '{"path":');

  assembler.applyDelta({
    type: "toolcall_end",
    contentIndex: 0,
    toolCall: { id: "call_1", name: "read", arguments: { path: "a.txt" } },
  });
  const done = assembler.snapshot().content[0];
  assert.ok(done?.type === "toolCall");
  assert.equal(done.id, "call_1");
  assert.equal(done.name, "read");
  assert.deepEqual(done.arguments, { path: "a.txt" });
});

test("two tool calls in one message stay separate", () => {
  const assembler = new MessageAssembler();
  for (const i of [0, 1]) assembler.applyDelta({ type: "toolcall_start", contentIndex: i });
  assembler.applyDelta({ type: "toolcall_delta", contentIndex: 0, delta: "a" });
  assembler.applyDelta({ type: "toolcall_delta", contentIndex: 1, delta: "b" });
  assembler.applyDelta({ type: "toolcall_delta", contentIndex: 0, delta: "a" });

  const blocks = assembler.snapshot().content;
  assert.equal(blocks.length, 2);
  assert.equal(blocks[0]!.type === "toolCall" && blocks[0]!.argsText, "aa");
  assert.equal(blocks[1]!.type === "toolCall" && blocks[1]!.argsText, "b");
});

test("a delta with no preceding _start is still rendered", () => {
  // A client that reconnects mid-turn sees this.
  const assembler = new MessageAssembler();
  assembler.applyDelta({ type: "text_delta", contentIndex: 3, delta: "orphan" });
  assert.equal(assembler.text(), "orphan");
});

test("message_start resets the accumulator between messages", () => {
  const transcript = new TranscriptAssembler();
  const assistant = { role: "assistant" as const, content: [] };

  transcript.apply({ type: "message_start", message: assistant });
  transcript.apply(delta({ type: "text_start", contentIndex: 0 }));
  transcript.apply(delta({ type: "text_delta", contentIndex: 0, delta: "one" }));
  transcript.apply({
    type: "message_end",
    message: { role: "assistant", content: [{ type: "text", text: "one" }] },
  });

  transcript.apply({ type: "message_start", message: assistant });
  transcript.apply(delta({ type: "text_start", contentIndex: 0 }));
  transcript.apply(delta({ type: "text_delta", contentIndex: 0, delta: "two" }));

  const snapshot = transcript.snapshot();
  assert.equal(snapshot.messages.length, 1);
  assert.equal(snapshot.streaming?.content[0]?.type === "text" && snapshot.streaming.content[0].text, "two");
});

test("a user message is recorded once, not once per start and end", () => {
  const transcript = new TranscriptAssembler();
  const message = { role: "user" as const, content: "hi" };
  transcript.apply({ type: "message_start", message });
  transcript.apply({ type: "message_end", message });
  assert.equal(transcript.snapshot().messages.length, 1);
});

test("agent_end does not end the run; agent_settled does", () => {
  const transcript = new TranscriptAssembler();
  transcript.apply({ type: "agent_start" });
  transcript.apply({ type: "agent_end", willRetry: true });
  assert.equal(transcript.snapshot().running, true);
  transcript.apply({ type: "agent_settled" });
  assert.equal(transcript.snapshot().running, false);
});

test("tool_execution_update replaces rather than appends", () => {
  const transcript = new TranscriptAssembler();
  transcript.apply({
    type: "tool_execution_start",
    toolCallId: "c1",
    toolName: "bash",
    args: { command: "ls" },
  });
  transcript.apply({
    type: "tool_execution_update",
    toolCallId: "c1",
    toolName: "bash",
    partialResult: { content: [{ type: "text" }] },
  });
  transcript.apply({
    type: "tool_execution_update",
    toolCallId: "c1",
    toolName: "bash",
    partialResult: { content: [{ type: "text" }, { type: "text" }] },
  });

  const [tool] = transcript.snapshot().toolExecutions;
  assert.deepEqual(tool!.partialResult, { content: [{ type: "text" }, { type: "text" }] });
  assert.equal(tool!.status, "running");
});

test("tool_execution_end with no preceding start still creates a card", () => {
  const transcript = new TranscriptAssembler();
  transcript.apply({
    type: "tool_execution_end",
    toolCallId: "c9",
    toolName: "read",
    isError: true,
  });
  const [tool] = transcript.snapshot().toolExecutions;
  assert.equal(tool!.status, "done");
  assert.equal(tool!.isError, true);
});
