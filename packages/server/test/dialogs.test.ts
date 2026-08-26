import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { ServerFrame } from "@pios/protocol";
import { startHarness, hello, TestClient, type Harness } from "./helpers.ts";

let harness: Harness;

before(async () => {
  harness = await startHarness();
});
after(async () => {
  await harness.close();
});

async function sessionAskingForConfirmation(client: TestClient, name: string) {
  const cwd = join(harness.dir, name);
  mkdirSync(cwd, { recursive: true });
  const created = client.send({ type: "create_session", cwd, trustProject: false });
  const frame = await client.waitForCommand(created);
  assert.equal(frame.type, "session_state", JSON.stringify(frame));
  const sessionId = frame.type === "session_state" ? frame.sessionId : "";

  await client.waitForCommand(client.send({ type: "subscribe", sessionId }));
  client.send({ type: "prompt", sessionId, messageId: `${name}-m1`, text: "ASK_DIALOG", images: [] });

  const asked = await client.waitFor(
    (f) => f.type === "extension_ui_request" && f.sessionId === sessionId,
  );
  assert.equal(asked.type, "extension_ui_request");
  const request = (asked as Extract<ServerFrame, { type: "extension_ui_request" }>).request;
  return { sessionId, request };
}

test("an extension dialog is delivered, answered, and dismissed everywhere", async () => {
  const client = await hello(harness);
  const other = await hello(harness);
  const { sessionId, request } = await sessionAskingForConfirmation(client, "dialog-a");
  await other.waitForCommand(other.send({ type: "subscribe", sessionId }));

  const answered = client.send({
    type: "extension_ui_response",
    sessionId,
    requestId: request.id,
    confirmed: true,
  });
  const ack = await client.waitForCommand(answered);
  assert.equal(ack.type, "ack");
  assert.equal(ack.type === "ack" ? ack.duplicate : true, false);

  // The other device is told to dismiss, rather than being left holding a
  // sheet for a question that is already answered.
  const closed = await other.waitFor(
    (f) => f.type === "extension_ui_closed" && f.sessionId === sessionId,
  );
  assert.equal(closed.type === "extension_ui_closed" ? closed.requestId : "", request.id);

  await client.waitFor(
    (f) => f.type === "agent_event" && f.sessionId === sessionId && f.event.type === "agent_settled",
  );

  // Answering a dialog nobody is waiting on is a duplicate, not an error: the
  // client cannot know the deadline expired before its answer arrived.
  const again = client.send({
    type: "extension_ui_response",
    sessionId,
    requestId: request.id,
    confirmed: true,
  });
  const repeat = await client.waitForCommand(again);
  assert.equal(repeat.type === "ack" ? repeat.duplicate : false, true);

  client.close();
  other.close();
});

test("a pending dialog is redelivered to a client that reconnects", async () => {
  const client = await hello(harness);
  const { sessionId, request } = await sessionAskingForConfirmation(client, "dialog-b");
  client.close();

  const returning = await hello(harness);
  // Far ahead of the ring buffer, so nothing is replayed and only the pending
  // dialog can account for the frame.
  await returning.waitForCommand(
    returning.send({ type: "subscribe", sessionId, sinceSeq: 9_999 }),
  );
  const resent = await returning.waitFor(
    (f) => f.type === "extension_ui_request" && f.sessionId === sessionId,
  );
  assert.equal(resent.type === "extension_ui_request" ? resent.request.id : "", request.id);

  returning.send({ type: "extension_ui_response", sessionId, requestId: request.id, cancelled: true });
  await returning.waitFor(
    (f) => f.type === "agent_event" && f.sessionId === sessionId && f.event.type === "agent_settled",
  );
  returning.close();
});

test("presentation survives a reconnect; a stray control byte does not eat a frame", async () => {
  const client = await hello(harness);
  const cwd = join(harness.dir, "dialog-c");
  mkdirSync(cwd, { recursive: true });
  const created = client.send({ type: "create_session", cwd, trustProject: false });
  const frame = await client.waitForCommand(created);
  const sessionId = frame.type === "session_state" ? frame.sessionId : "";
  await client.waitForCommand(client.send({ type: "subscribe", sessionId }));

  client.send({ type: "prompt", sessionId, messageId: "c-m1", text: "SHOW_STATUS", images: [] });
  await client.waitFor(
    (f) => f.type === "extension_ui_request" && f.request.method === "setStatus",
  );
  // The bell was written immediately before this frame, so receiving the turn
  // intact proves the stray byte did not corrupt the record behind it.
  await client.waitFor(
    (f) => f.type === "agent_event" && f.sessionId === sessionId && f.event.type === "agent_settled",
  );
  client.close();

  const returning = await hello(harness);
  await returning.waitForCommand(returning.send({ type: "subscribe", sessionId, sinceSeq: 9_999 }));
  const snapshot = await returning.waitFor(
    (f) => f.type === "extension_ui_state" && f.sessionId === sessionId,
  );
  assert.equal(snapshot.type, "extension_ui_state");
  const presentation = (snapshot as Extract<ServerFrame, { type: "extension_ui_state" }>).presentation;
  assert.deepEqual(presentation.status, [{ key: "nolo", text: "YOLO" }]);
  returning.close();
});
