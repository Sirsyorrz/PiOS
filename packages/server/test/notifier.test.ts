import assert from "node:assert/strict";
import { test } from "node:test";
import type { BufferedEvent, HostEvent, PiSession, SessionInfo } from "@pios/pi-host";
import type { AgentEvent } from "@pios/protocol";
import { SettleNotifier, type Notification } from "../src/notifier.ts";

/** Just enough session for the notifier: an id, an info block, and events. */
function fakeSession(overrides: Partial<SessionInfo> = {}) {
  const listeners = new Set<(event: BufferedEvent) => void>();
  let seq = 0;
  const info = {
    id: "s1",
    name: "demo",
    cwd: "/home/user/Code/demo",
    status: "idle",
    awaitingInput: false,
    trusted: true,
    leafId: null,
    lastSeq: 0,
    updatedAt: 0,
    ...overrides,
  } as SessionInfo;

  const session = {
    id: info.id,
    info,
    subscribe(listener: (event: BufferedEvent) => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  } as unknown as PiSession;

  const emit = (event: AgentEvent) => {
    seq += 1;
    const host: HostEvent = { type: "agent_event", event };
    for (const listener of [...listeners]) listener({ seq, at: seq * 1000, event: host });
  };
  return { session, emit, info };
}

/** A finished assistant turn, as pi reports it. */
function assistantMessage(text: string): AgentEvent {
  return {
    type: "message_end",
    message: { role: "assistant", content: [{ type: "text", text }] },
  } as AgentEvent;
}

function collector() {
  const sent: Notification[] = [];
  return {
    sent,
    deps: {
      send: (notification: Notification) => void sent.push(notification),
      watchers: () => new Set<string>(),
    },
  };
}

test("one notification per settled turn", () => {
  const { sent, deps } = collector();
  const notifier = new SettleNotifier({ ...deps, now: () => 5_000 });
  const { session, emit } = fakeSession();
  notifier.attach(session);

  emit({ type: "agent_start" } as AgentEvent);
  emit({ type: "tool_execution_start", toolCallId: "1", toolName: "bash" } as AgentEvent);
  emit(assistantMessage("The **tests** pass now."));
  emit({ type: "agent_end", reason: "done" } as AgentEvent);
  emit({ type: "agent_settled" } as AgentEvent);

  assert.equal(sent.length, 1);
  assert.equal(sent[0]!.message.title, "demo");
  // What the agent said, not how it spent its time.
  assert.equal(sent[0]!.message.body, "The tests pass now.");
  assert.equal(sent[0]!.message.url, "/?session=s1");
});

test("a settle with no turn behind it is silent", () => {
  const { sent, deps } = collector();
  const notifier = new SettleNotifier(deps);
  const { session, emit } = fakeSession();
  notifier.attach(session);

  emit({ type: "agent_settled" } as AgentEvent);
  assert.equal(sent.length, 0);
});

test("a session waiting on the user says so", () => {
  const { sent, deps } = collector();
  const notifier = new SettleNotifier(deps);
  const { session, emit } = fakeSession({ awaitingInput: true });
  notifier.attach(session);

  emit({ type: "agent_start" } as AgentEvent);
  emit({ type: "agent_settled" } as AgentEvent);
  assert.match(sent[0]!.message.body, /Needs input/);
});

test("devices watching the session are skipped", () => {
  const sent: Notification[] = [];
  const notifier = new SettleNotifier({
    send: (notification) => void sent.push(notification),
    watchers: () => new Set(["device-a"]),
  });
  const { session, emit } = fakeSession();
  notifier.attach(session);

  emit({ type: "agent_start" } as AgentEvent);
  emit({ type: "agent_settled" } as AgentEvent);
  assert.deepEqual([...sent[0]!.skipDeviceIds], ["device-a"]);
});

test("a released session stops notifying", () => {
  const { sent, deps } = collector();
  const notifier = new SettleNotifier(deps);
  const { session, emit } = fakeSession();
  notifier.attach(session);
  notifier.release(session.id);

  emit({ type: "agent_start" } as AgentEvent);
  emit({ type: "agent_settled" } as AgentEvent);
  assert.equal(sent.length, 0);
});

test("the title falls back the way the session list does", () => {
  const { sent, deps } = collector();
  const notifier = new SettleNotifier(deps);
  const { session, emit } = fakeSession({ name: undefined, preview: "fix the flaky test" });
  notifier.attach(session);

  emit({ type: "agent_start" } as AgentEvent);
  emit({ type: "agent_settled" } as AgentEvent);
  assert.equal(sent[0]!.message.title, "fix the flaky test");
});

test("with neither a name nor a preview the directory places it", () => {
  const { sent, deps } = collector();
  const notifier = new SettleNotifier(deps);
  const { session, emit } = fakeSession({ name: undefined, preview: undefined });
  notifier.attach(session);

  emit({ type: "agent_start" } as AgentEvent);
  emit({ type: "agent_settled" } as AgentEvent);
  assert.equal(sent[0]!.message.title, ".../Code/demo");
});

test("a long answer is clipped on a word", () => {
  const { sent, deps } = collector();
  const notifier = new SettleNotifier(deps);
  const { session, emit } = fakeSession();
  notifier.attach(session);

  emit({ type: "agent_start" } as AgentEvent);
  emit(assistantMessage(`${"alpha bravo ".repeat(40)}end`));
  emit({ type: "agent_settled" } as AgentEvent);

  const body = sent[0]!.message.body;
  assert.ok(body.length <= 184, body.length.toString());
  assert.match(body, /\.\.\.$/);
  assert.equal(body.includes("  "), false);
});

test("tool output and thinking are not the answer", () => {
  const { sent, deps } = collector();
  const notifier = new SettleNotifier(deps);
  const { session, emit } = fakeSession();
  notifier.attach(session);

  emit({ type: "agent_start" } as AgentEvent);
  emit({
    type: "message_end",
    message: { role: "toolResult", content: [{ type: "text", text: "raw tool output" }] },
  } as AgentEvent);
  emit({ type: "agent_settled" } as AgentEvent);
  assert.match(sent[0]!.message.body, /^Finished/);
});

test("a turn that ends in a provider error says so", () => {
  const { sent, deps } = collector();
  const notifier = new SettleNotifier(deps);
  const { session, emit } = fakeSession();
  notifier.attach(session);

  const failed = {
    type: "message_end",
    message: {
      role: "assistant",
      content: [],
      stopReason: "error",
      errorMessage: '429: {"message":"Rate limit reached","type":"rate_limit"}',
    },
  } as AgentEvent;
  emit({ type: "agent_start" } as AgentEvent);
  emit(assistantMessage("Looking into it."));
  emit(failed);
  emit({ type: "agent_end" } as AgentEvent);
  emit({ type: "agent_start" } as AgentEvent);
  emit(failed);
  emit({ type: "agent_settled" } as AgentEvent);

  assert.equal(sent.length, 1);
  assert.equal(sent[0]!.message.body, "Failed: 429: Rate limit reached");
});

test("a retry that recovers reads as the answer, not the error", () => {
  const { sent, deps } = collector();
  const notifier = new SettleNotifier(deps);
  const { session, emit } = fakeSession();
  notifier.attach(session);

  emit({ type: "agent_start" } as AgentEvent);
  emit({
    type: "message_end",
    message: { role: "assistant", content: [], stopReason: "error", errorMessage: "overloaded" },
  } as AgentEvent);
  emit({ type: "agent_start" } as AgentEvent);
  emit(assistantMessage("Done."));
  emit({ type: "agent_settled" } as AgentEvent);

  assert.equal(sent[0]!.message.body, "Done.");
});
