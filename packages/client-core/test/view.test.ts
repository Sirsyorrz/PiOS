import { test } from "node:test";
import assert from "node:assert/strict";
import type { AgentEvent } from "@pios/protocol";
import { SessionStore } from "../src/session-store.ts";
import { sessionView } from "../src/view.ts";
import type { OutboxEntry } from "../src/outbox.ts";

const userMessage = { role: "user" as const, content: "hello", timestamp: 10 };

function pending(text: string): OutboxEntry {
  return {
    messageId: "m1",
    commandId: "c1",
    sessionId: "s1",
    text,
    images: [],
    createdAt: 0,
    attempts: 0,
    status: "queued",
  };
}

test("a message present in both history and the live stream renders once", () => {
  const store = new SessionStore();
  store.applyEntries("s1", [{ id: "e1", type: "message", message: userMessage }], "e1", true);
  store.applyEvent("s1", 1, { type: "message_end", message: userMessage } as AgentEvent);

  const view = sessionView(store, [], "s1");
  assert.equal(view.items.filter((i) => i.kind === "message").length, 1);
});

test("the system prompt entry is not rendered", () => {
  const store = new SessionStore();
  store.applyEntries(
    "s1",
    [
      { id: "e0", type: "message", message: { role: "system", content: "you are pi" } },
      { id: "e1", type: "message", message: userMessage },
    ],
    "e1",
    true,
  );

  const view = sessionView(store, [], "s1");
  const messages = view.items.filter((i) => i.kind === "message");
  assert.equal(messages.length, 1);
});

test("tool results are folded onto their tool card, not rendered as messages", () => {
  const store = new SessionStore();
  store.applyEntries(
    "s1",
    [
      {
        id: "e1",
        type: "message",
        message: {
          role: "toolResult",
          toolCallId: "t1",
          toolName: "read",
          content: [{ type: "text", text: "file body" }],
        },
      },
    ],
    "e1",
    true,
  );

  const view = sessionView(store, [], "s1");
  assert.equal(view.items.length, 0);
  assert.equal(view.tools.get("t1")?.status, "done");
});

test("live tool state wins over the persisted result", () => {
  const store = new SessionStore();
  store.applyEntries(
    "s1",
    [
      {
        id: "e1",
        type: "message",
        message: { role: "toolResult", toolCallId: "t1", toolName: "read", content: [] },
      },
    ],
    "e1",
    true,
  );
  store.applyEvent("s1", 1, { type: "agent_start" } as AgentEvent);
  store.applyEvent("s1", 2, {
    type: "tool_execution_start",
    toolCallId: "t1",
    toolName: "read",
    args: { path: "a.txt" },
  } as AgentEvent);

  const tool = sessionView(store, [], "s1").tools.get("t1");
  assert.deepEqual(tool?.args, { path: "a.txt" });
  assert.equal(tool?.status, "running");
});

test("a tool left unfinished by a restart stops looking like it is running", () => {
  const store = new SessionStore();
  store.applyEntries(
    "s1",
    [
      {
        id: "e1",
        type: "message",
        message: {
          role: "assistant",
          content: [{ type: "toolCall", id: "t1", name: "bash", arguments: { command: "sleep 10" } }],
        },
      },
    ],
    "e1",
    true,
  );

  // No result entry and no live run: the agent died holding the call.
  const tool = sessionView(store, [], "s1").tools.get("t1");
  assert.equal(tool?.status, "abandoned");
});

test("queued prompts render after everything the daemon has confirmed", () => {
  const store = new SessionStore();
  store.applyEntries("s1", [{ id: "e1", type: "message", message: userMessage }], "e1", true);

  const view = sessionView(store, [pending("later"), { ...pending("elsewhere"), sessionId: "s2" }], "s1");
  assert.deepEqual(
    view.items.map((i) => i.kind),
    ["message", "pending"],
  );
});

test("banner state is carried out of the event stream", () => {
  const store = new SessionStore();
  store.applyEvent("s1", 1, { type: "compaction_start", reason: "threshold" } as AgentEvent);
  store.applyEvent("s1", 2, {
    type: "extension_error",
    extensionPath: "/x.ts",
    error: "boom",
  } as AgentEvent);

  const status = sessionView(store, [], "s1").status;
  assert.equal(status.compaction?.reason, "threshold");
  assert.equal(status.extensionErrors[0]?.error, "boom");
});

test("a stopped agent stops looking busy even without agent_settled", () => {
  const store = new SessionStore();
  store.applyEvent("s1", 1, { type: "agent_start" } as AgentEvent);
  assert.equal(sessionView(store, [], "s1").running, true);

  store.setInterrupting("s1", true);
  assert.equal(sessionView(store, [], "s1").interrupting, true);

  // The daemon aborts the turn and reports idle; no `agent_settled` arrives.
  store.setDaemonStatus("s1", "idle");
  const view = sessionView(store, [], "s1");
  assert.equal(view.running, false);
  assert.equal(view.interrupting, false);
});

test("a tool card rebuilt from history keeps the call, not just its output", () => {
  const store = new SessionStore();
  store.applyEntries(
    "s1",
    [
      {
        id: "e1",
        type: "message",
        message: {
          role: "assistant",
          content: [{ type: "toolCall", id: "t1", name: "bash", arguments: { command: "ls -la" } }],
        },
      },
      {
        id: "e2",
        type: "message",
        message: {
          role: "toolResult",
          toolCallId: "t1",
          toolName: "bash",
          content: [{ type: "text", text: "total 0" }],
        },
      },
    ],
    "e2",
    true,
  );

  const tool = sessionView(store, [], "s1").tools.get("t1");
  assert.deepEqual(tool?.args, { command: "ls -la" });
  assert.equal(tool?.status, "done");
});
