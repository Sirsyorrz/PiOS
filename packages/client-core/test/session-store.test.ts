import { test } from "node:test";
import assert from "node:assert/strict";
import { SessionStore } from "../src/session-store.ts";
import { MemoryStorage } from "../src/storage.ts";
import { AppStatePolicy, BACKGROUND_RECONNECT_AFTER_MS } from "../src/app-state.ts";
import { FakeScheduler } from "../src/scheduler.ts";
import { entry } from "./fake-transport.ts";

test("a delta is appended and the cursor advances", () => {
  const store = new SessionStore();
  store.applyEntries("s1", [entry("e1"), entry("e2", "e1")], "e2", false);
  assert.equal(store.cursor("s1"), "e2");

  store.applyEntries("s1", [entry("e3", "e2")], "e3", false);
  assert.equal(store.get("s1").entries.length, 3);
  assert.equal(store.cursor("s1"), "e3");
});

test("a redelivered entry is not duplicated", () => {
  const store = new SessionStore();
  store.applyEntries("s1", [entry("e1")], "e1", false);
  store.applyEntries("s1", [entry("e1"), entry("e2", "e1")], "e2", false);
  assert.deepEqual(store.get("s1").entries.map((e) => e.id), ["e1", "e2"]);
});

test("a reset replaces the transcript instead of appending to it", () => {
  const store = new SessionStore();
  store.applyEntries("s1", [entry("old1"), entry("old2", "old1")], "old2", false);
  store.applyEntries("s1", [entry("new1"), entry("new2", "new1")], "new2", true);

  assert.deepEqual(store.get("s1").entries.map((e) => e.id), ["new1", "new2"]);
  assert.equal(store.cursor("s1"), "new2");
});

test("a leaf the cache has never seen forces a full refetch", () => {
  const store = new SessionStore();
  store.applyEntries("s1", [entry("e1"), entry("e2", "e1")], "e2", false);

  assert.equal(store.needsFullRefetch("s1", "e2"), false, "same leaf, nothing to do");
  assert.equal(store.needsFullRefetch("s1", "e1"), false, "an older leaf is still known");
  // Another client forked: the branch moved somewhere this cache cannot reach.
  assert.equal(store.needsFullRefetch("s1", "forked-1"), true);
});

test("an unknown leaf is not mistaken for an empty session", () => {
  const store = new SessionStore();
  store.applyEntries("s1", [entry("e1")], "e1", false);
  // A cold session reports no leaf because its cursor lives in its file, so
  // null must not throw away a transcript that is perfectly current.
  assert.equal(store.needsFullRefetch("s1", null), false);
  assert.equal(store.needsFullRefetch("s1", "moved-elsewhere"), true);
});

test("the cache survives a restart, cursor and all", () => {
  const storage = new MemoryStorage();
  const store = new SessionStore(storage);
  store.applyEntries("s1", [entry("e1"), entry("e2", "e1")], "e2", false);

  const restarted = new SessionStore(storage.clone());
  assert.equal(restarted.cursor("s1"), "e2");
  assert.equal(restarted.get("s1").entries.length, 2);
});

test("live events build a transcript and advance the seq cursor", () => {
  const store = new SessionStore();
  store.applyEvent("s1", 1, { type: "agent_start" });
  store.applyEvent("s1", 2, {
    type: "message_start",
    message: { role: "assistant", content: [] },
  });
  store.applyEvent("s1", 3, {
    type: "message_update",
    assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "hi" },
  });

  assert.equal(store.lastSeq("s1"), 3);
  const streaming = store.transcript("s1").streaming;
  assert.equal(streaming?.content[0]?.type === "text" && streaming.content[0].text, "hi");
  assert.equal(store.transcript("s1").running, true);
});

test("a gap rebuilds the live transcript rather than leaving a hole", () => {
  const store = new SessionStore();
  store.applyEvent("s1", 5, {
    type: "message_update",
    assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "partial" },
  });
  assert.equal(store.lastSeq("s1"), 5);

  store.resetLiveTranscript("s1");
  assert.equal(store.lastSeq("s1"), 0);
  assert.equal(store.transcript("s1").streaming, null);
});

test("background under ten seconds probes, over it reconnects", () => {
  const scheduler = new FakeScheduler();
  const calls: string[] = [];
  const policy = new AppStatePolicy(
    { wake: (reason) => calls.push(`wake:${reason}`), probe: () => calls.push("probe") },
    { scheduler },
  );

  policy.set("background");
  void scheduler.advance(BACKGROUND_RECONNECT_AFTER_MS - 1);
  policy.set("active");
  assert.deepEqual(calls, ["probe"]);

  policy.set("background");
  void scheduler.advance(BACKGROUND_RECONNECT_AFTER_MS);
  policy.set("active");
  assert.deepEqual(calls, ["probe", "wake:application-active-reconnect"]);
});

test("going inactive without backgrounding does nothing", () => {
  const scheduler = new FakeScheduler();
  const calls: string[] = [];
  const policy = new AppStatePolicy(
    { wake: () => calls.push("wake"), probe: () => calls.push("probe") },
    { scheduler },
  );

  // A notification shade pulled down is not a reason to touch the socket.
  policy.set("inactive");
  policy.set("active");
  assert.deepEqual(calls, ["probe"]);
});

test("a daemon start time is rewritten into the local clock", () => {
  const store = new SessionStore();
  // The daemon's clock runs an hour ahead of this one.
  const skewMs = 3_600_000;
  const at = Date.now() + skewMs;

  store.applyEvent(
    "s1",
    1,
    {
      type: "tool_execution_start",
      toolCallId: "call-1",
      toolName: "bash",
      startedAt: at - 5_000,
    },
    at,
  );

  const tool = store.transcript("s1").toolExecutions[0];
  assert.ok(tool?.startedAt !== undefined);
  const elapsed = Date.now() - tool.startedAt;
  assert.ok(elapsed > 4_000 && elapsed < 6_000, `skew was not corrected: ${elapsed}`);
});

test("a duration survives the trip to the transcript", () => {
  const store = new SessionStore();
  store.applyEvent("s1", 1, {
    type: "tool_execution_start",
    toolCallId: "call-1",
    toolName: "bash",
  });
  store.applyEvent("s1", 2, {
    type: "tool_execution_end",
    toolCallId: "call-1",
    toolName: "bash",
    durationMs: 10_042,
  });

  assert.equal(store.transcript("s1").toolExecutions[0]?.durationMs, 10_042);
});

test("time spent on a confirmation is not charged to the tool call", async () => {
  const store = new SessionStore();
  const at = Date.now();
  store.applyEvent(
    "s1",
    1,
    { type: "tool_execution_start", toolCallId: "call-1", toolName: "bash", startedAt: at },
    at,
  );

  store.openDialog("s1", { type: "extension_ui_request", id: "d1", method: "confirm", title: "Run this?" });
  await new Promise((resolve) => setTimeout(resolve, 60));
  store.closeDialog("s1", "d1");

  // The call has been alive for 60ms but has worked for none of them.
  const tool = store.transcript("s1").toolExecutions[0];
  assert.ok(tool?.startedAt !== undefined);
  assert.ok(Date.now() - tool.startedAt < 20, `charged for the wait: ${Date.now() - tool.startedAt}`);
});

test("a call that starts mid-dialog only loses the rest of the wait", async () => {
  const store = new SessionStore();
  store.openDialog("s1", { type: "extension_ui_request", id: "d1", method: "confirm", title: "Run this?" });
  await new Promise((resolve) => setTimeout(resolve, 60));

  // Started while blocked: the 60ms before it existed are not its to lose.
  const at = Date.now();
  store.applyEvent(
    "s1",
    1,
    { type: "tool_execution_start", toolCallId: "call-1", toolName: "bash", startedAt: at },
    at,
  );
  store.closeDialog("s1", "d1");

  const tool = store.transcript("s1").toolExecutions[0];
  assert.ok(tool?.startedAt !== undefined && tool.startedAt <= Date.now() + 5);
  assert.ok(Date.now() - tool.startedAt < 20);
});
