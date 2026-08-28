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
  emit({ type: "agent_end", reason: "done" } as AgentEvent);
  emit({ type: "agent_settled" } as AgentEvent);

  assert.equal(sent.length, 1);
  assert.equal(sent[0]!.message.title, "demo");
  assert.match(sent[0]!.message.body, /done/);
  assert.match(sent[0]!.message.body, /last: bash/);
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
  assert.match(sent[0]!.message.body, /needs input/);
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
