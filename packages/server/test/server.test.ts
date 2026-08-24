import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { WIRE_VERSION, type ServerFrame } from "@pios/protocol";
import { startHarness, hello, TestClient, type Harness } from "./helpers.ts";

let harness: Harness;

before(async () => {
  harness = await startHarness();
});
after(async () => {
  await harness.close();
});

async function createSession(client: TestClient, cwd: string): Promise<string> {
  const id = client.send({ type: "create_session", cwd, trustProject: false });
  const frame = await client.waitForCommand(id);
  assert.equal(frame.type, "session_state", JSON.stringify(frame));
  return frame.type === "session_state" ? frame.sessionId : "";
}

function summaryOf(client: TestClient, sessionId: string) {
  const welcome = client.received.find((f) => f.type === "welcome");
  assert.ok(welcome?.type === "welcome");
  const summary = welcome.sessions.find((s) => s.sessionId === sessionId);
  assert.ok(summary, `no summary for ${sessionId}`);
  return summary;
}

function settled(client: TestClient, sessionId: string) {
  return client.waitFor(
    (f) =>
      f.type === "agent_event" && f.sessionId === sessionId && f.event.type === "agent_settled",
  );
}

test("health is public and says nothing about sessions", async () => {
  const res = await fetch(`${harness.baseUrl}/health`);
  assert.equal(res.status, 200);
  const body = (await res.json()) as Record<string, unknown>;
  assert.deepEqual(Object.keys(body).sort(), ["ok", "serverVersion", "wireVersion"]);
  assert.equal(body.wireVersion, WIRE_VERSION);
});

test("every other route rejects an unauthenticated caller", async () => {
  for (const path of ["/sessions", "/dirs", "/file?session=x&path=y", "/upload?session=x"]) {
    const res = await fetch(`${harness.baseUrl}${path}`, {
      method: path.startsWith("/upload") ? "POST" : "GET",
      body: path.startsWith("/upload") ? "x" : undefined,
    });
    assert.equal(res.status, 401, path);
  }
  const wrong = await fetch(`${harness.baseUrl}/sessions`, {
    headers: { authorization: "Bearer wrong" },
  });
  assert.equal(wrong.status, 401);
});

test("a socket that never says hello is closed", async () => {
  const client = await TestClient.connect(harness);
  const { code } = await client.closed();
  assert.equal(code, 4401);
});

test("a socket with a bad token is closed, not answered", async () => {
  const client = await TestClient.connect(harness);
  client.send({ type: "hello", deviceToken: "nope", clientVersion: "test" });
  const { code } = await client.closed();
  assert.equal(code, 4401);
  assert.deepEqual(client.received, [], "nothing is disclosed to an unauthorised socket");
});

test("commands before hello are refused", async () => {
  const client = await TestClient.connect(harness);
  client.send({ type: "list_sessions" });
  const { code } = await client.closed();
  assert.equal(code, 4401);
});

test("a frame from another wire version is rejected with a clear reason", async () => {
  const client = await hello(harness);
  const socket = (client as unknown as { socket: { send(d: string): void } }).socket;
  socket.send(JSON.stringify({ v: 99, type: "list_sessions", commandId: "v99" }));

  const frame = await client.waitFor((f) => f.type === "error");
  assert.equal(frame.type === "error" && frame.code, "bad_request");
  assert.match(frame.type === "error" ? frame.message : "", /wire version 99/);
  client.close();
});

test("session lifecycle: create, prompt, stream, resync", async () => {
  const client = await hello(harness);
  const cwd = join(harness.dir, "work");
  mkdirSync(cwd, { recursive: true });

  const sessionId = await createSession(client, cwd);
  const subscribed = client.send({ type: "subscribe", sessionId });
  await client.waitForCommand(subscribed);

  const promptId = client.send({
    type: "prompt",
    sessionId,
    messageId: "m1",
    text: "hello",
    images: [],
  });
  const ack = await client.waitForCommand(promptId);
  assert.equal(ack.type, "ack");

  await settled(client, sessionId);

  const deltas = client.received
    .filter((f): f is Extract<ServerFrame, { type: "agent_event" }> => f.type === "agent_event")
    .map((f) => f.event)
    .filter((e) => e.type === "message_update" && e.assistantMessageEvent.type === "text_delta")
    .map((e) => (e.type === "message_update" && "delta" in e.assistantMessageEvent ? e.assistantMessageEvent.delta : ""));
  assert.equal(deltas.join(""), "echo: hello");

  const entriesId = client.send({ type: "get_entries", sessionId });
  const entries = await client.waitForCommand(entriesId);
  assert.equal(entries.type, "entries");
  assert.equal(entries.type === "entries" && entries.entries.length, 2);
  client.close();
});

test("a reconnecting client resumes from its entry cursor", async () => {
  const client = await hello(harness);
  const cwd = join(harness.dir, "resume");
  mkdirSync(cwd, { recursive: true });
  const sessionId = await createSession(client, cwd);

  await client.waitForCommand(client.send({ type: "subscribe", sessionId }));
  client.send({ type: "prompt", sessionId, messageId: "m1", text: "one", images: [] });
  await settled(client, sessionId);

  const first = await client.waitForCommand(client.send({ type: "get_entries", sessionId }));
  const cursor = first.type === "entries" ? first.leafId! : "";
  client.close();

  // A second prompt happens while nobody is connected: the daemon owns the
  // session, so the agent does not care that the client went away.
  const second = await hello(harness);
  // Subscribing from the live cursor, so the previous run is not replayed as
  // if it were happening now.
  const summary = summaryOf(second, sessionId);
  await second.waitForCommand(
    second.send({ type: "subscribe", sessionId, sinceSeq: summary.lastSeq }),
  );
  second.send({ type: "prompt", sessionId, messageId: "m2", text: "two", images: [] });
  await settled(second, sessionId);

  const delta = await second.waitForCommand(
    second.send({ type: "get_entries", sessionId, since: cursor }),
  );
  assert.equal(delta.type, "entries");
  assert.equal(delta.type === "entries" && delta.reset, false);
  assert.equal(delta.type === "entries" && delta.entries.length, 2, "only what was missed");
  second.close();
});

test("an unknown cursor asks the client to start over", async () => {
  const client = await hello(harness);
  const cwd = join(harness.dir, "cursor");
  mkdirSync(cwd, { recursive: true });
  const sessionId = await createSession(client, cwd);

  const frame = await client.waitForCommand(
    client.send({ type: "get_entries", sessionId, since: "bogus" }),
  );
  assert.equal(frame.type === "entries" && frame.reset, true);
  client.close();
});

test("a redelivered prompt is acked but not run twice", async () => {
  const client = await hello(harness);
  const cwd = join(harness.dir, "dedupe");
  mkdirSync(cwd, { recursive: true });
  const sessionId = await createSession(client, cwd);
  await client.waitForCommand(client.send({ type: "subscribe", sessionId }));

  const commandId = "outbox-1";
  client.send({ type: "prompt", sessionId, messageId: "m1", text: "once", images: [], commandId });
  await client.waitForCommand(commandId);
  await settled(client, sessionId);

  // Exactly what the outbox does after a lost ack.
  client.send({ type: "prompt", sessionId, messageId: "m1", text: "once", images: [], commandId });
  const repeat = await client.waitFor(
    (f) => f.type === "ack" && f.commandId === commandId && f.duplicate === true,
  );
  assert.equal(repeat.type === "ack" && repeat.duplicate, true);

  const entries = await client.waitForCommand(client.send({ type: "get_entries", sessionId }));
  assert.equal(entries.type === "entries" && entries.entries.length, 2, "one turn, not two");
  client.close();
});

test("late subscribers replay buffered events and are told about gaps", async () => {
  const client = await hello(harness);
  const cwd = join(harness.dir, "replay");
  mkdirSync(cwd, { recursive: true });
  const sessionId = await createSession(client, cwd);

  await client.waitForCommand(client.send({ type: "subscribe", sessionId }));
  client.send({ type: "prompt", sessionId, messageId: "m1", text: "buffered", images: [] });
  await settled(client, sessionId);
  client.close();

  const late = await hello(harness);
  const subscribed = await late.waitForCommand(late.send({ type: "subscribe", sessionId }));
  assert.equal(subscribed.type, "subscribed");
  assert.equal(subscribed.type === "subscribed" && subscribed.gap, false);
  assert.ok(
    late.received.some((f) => f.type === "agent_event" && f.event.type === "agent_settled"),
    "the whole run was replayed to a client that was not there",
  );
  late.close();
});

test("files are served from inside the session cwd only", async () => {
  const client = await hello(harness);
  const cwd = join(harness.dir, "files");
  mkdirSync(cwd, { recursive: true });
  writeFileSync(join(cwd, "note.txt"), "visible");
  writeFileSync(join(harness.dir, "private.txt"), "hidden");
  const sessionId = await createSession(client, cwd);

  const auth = { authorization: `Bearer ${harness.deviceToken}` };
  const ok = await fetch(`${harness.baseUrl}/file?session=${sessionId}&path=note.txt`, {
    headers: auth,
  });
  assert.equal(ok.status, 200);
  assert.equal(await ok.text(), "visible");

  const escape = await fetch(
    `${harness.baseUrl}/file?session=${sessionId}&path=../private.txt`,
    { headers: auth },
  );
  // 404, not 403: a different answer would confirm the file exists.
  assert.equal(escape.status, 404);
  client.close();
});

test("uploads land inside the session cwd", async () => {
  const client = await hello(harness);
  const cwd = join(harness.dir, "uploads");
  mkdirSync(cwd, { recursive: true });
  const sessionId = await createSession(client, cwd);

  const res = await fetch(
    `${harness.baseUrl}/upload?session=${sessionId}&name=../../escape.png`,
    {
      method: "POST",
      headers: { authorization: `Bearer ${harness.deviceToken}` },
      body: Buffer.from("image-bytes"),
    },
  );
  assert.equal(res.status, 200);
  const { path } = (await res.json()) as { path: string };
  assert.ok(path.startsWith(join(cwd, ".pios-uploads")), `escaped to ${path}`);
  client.close();
});

test("directory listing stays inside the home directory", async () => {
  const auth = { authorization: `Bearer ${harness.deviceToken}` };
  const home = await fetch(`${harness.baseUrl}/dirs`, { headers: auth });
  assert.equal(home.status, 200);
  const listing = (await home.json()) as {
    root: string;
    parent: string | null;
    entries: { name: string; path: string }[];
  };
  assert.equal(listing.parent, null, "the root has nowhere further up");
  assert.ok(listing.entries.every((e) => e.path.startsWith(listing.root)));
  assert.ok(listing.entries.every((e) => !e.name.startsWith(".")));

  const escape = await fetch(`${harness.baseUrl}/dirs?path=/etc`, { headers: auth });
  assert.equal(escape.status, 404);
});

test("an unknown session is refused rather than crashing the socket", async () => {
  const client = await hello(harness);
  const frame = await client.waitForCommand(
    client.send({ type: "get_entries", sessionId: "ghost" }),
  );
  assert.equal(frame.type === "error" && frame.code, "unknown_session");

  // The socket still works afterwards.
  const list = await client.waitForCommand(client.send({ type: "list_sessions" }));
  assert.equal(list.type, "sessions");
  client.close();
});

test("a cross-origin preflight is answered without credentials", async () => {
  const res = await fetch(`${harness.baseUrl}/pair`, {
    method: "OPTIONS",
    headers: {
      origin: "http://phone.local:5173",
      "access-control-request-method": "POST",
      "access-control-request-headers": "content-type",
    },
  });
  assert.equal(res.status, 204);
  assert.equal(res.headers.get("access-control-allow-origin"), "http://phone.local:5173");
  assert.ok(res.headers.get("access-control-allow-headers")?.includes("authorization"));
  // Never set: a bearer token is not a cookie, and allowing credentials would
  // let a hostile page ride an ambient session.
  assert.equal(res.headers.get("access-control-allow-credentials"), null);

  const listing = await fetch(`${harness.baseUrl}/dirs`, {
    headers: { authorization: `Bearer ${harness.deviceToken}`, origin: "http://phone.local:5173" },
  });
  assert.equal(listing.headers.get("access-control-allow-origin"), "http://phone.local:5173");
});
