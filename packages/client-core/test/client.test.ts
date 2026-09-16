import { test } from "node:test";
import assert from "node:assert/strict";
import { WIRE_VERSION } from "@pios/protocol";
import { PiosClient } from "../src/client.ts";
import { FakeScheduler, flush } from "../src/scheduler.ts";
import { MemoryStorage } from "../src/storage.ts";
import { TransportFactoryStub, summary, entry } from "./fake-transport.ts";

/** Skips the backoff wait when the test is not about timing. */
function supervisorWake(client: PiosClient) {
  client.supervisor.wake("test");
}

function setup(storage = new MemoryStorage()) {
  const scheduler = new FakeScheduler();
  const transports = new TransportFactoryStub();
  let counter = 0;
  const client = new PiosClient({
    createTransport: transports.create,
    scheduler,
    storage,
    backoff: { baseMs: 1000, capMs: 16_000, factor: 2 },
    generateId: () => `id-${++counter}`,
    generateCommandId: () => `hello-${++counter}`,
  });
  client.start({ url: "ws://test", deviceToken: "token" });
  return { scheduler, transports, client, storage };
}

test("watching a session resyncs from its cursor and subscribes from its seq", async () => {
  const { transports, client } = setup();
  await flush();
  transports.last.acceptHello([summary({ sessionId: "s1", leafId: null })]);
  client.watch("s1");

  const [entries] = transports.last.sentOfType("get_entries");
  assert.equal(entries?.since, undefined, "no cursor yet, so ask for everything");
  const [subscribe] = transports.last.sentOfType("subscribe");
  assert.equal(subscribe?.sinceSeq, 0);

  transports.last.emit({
    v: WIRE_VERSION,
    type: "entries",
    sessionId: "s1",
    entries: [entry("e1"), entry("e2", "e1")],
    leafId: "e2",
    reset: false,
    offset: 0,
    total: 0,
  });
  assert.equal(client.sessions.cursor("s1"), "e2");
  assert.equal(client.supervisor.getState().sync, "synced");
});

test("a settled turn is fetched as entries, so its ids exist before a reconnect", async () => {
  const { transports, client } = setup();
  await flush();
  transports.last.acceptHello([summary({ sessionId: "s1", leafId: null })]);
  client.watch("s1");
  transports.last.emit({
    v: WIRE_VERSION,
    type: "entries",
    sessionId: "s1",
    entries: [entry("e1")],
    leafId: "e1",
    reset: false,
    offset: 0,
    total: 0,
  });

  transports.last.emit({
    v: WIRE_VERSION,
    type: "agent_event",
    sessionId: "s1",
    seq: 7,
    event: { type: "agent_settled" },
  });

  const fetches = transports.last.sentOfType("get_entries");
  assert.equal(fetches.length, 2, "the finished turn is asked for");
  assert.equal(fetches.at(-1)?.since, "e1", "a delta from the cursor, not the whole session");
});

test("a drop mid-stream reconnects and resumes from the cursor", async () => {
  const { scheduler, transports, client } = setup();
  await flush();
  transports.last.acceptHello([summary({ sessionId: "s1" })]);
  client.watch("s1");

  transports.last.emit({
    v: WIRE_VERSION,
    type: "entries",
    sessionId: "s1",
    entries: [entry("e1")],
    leafId: "e1",
    reset: false,
    offset: 0,
    total: 0,
  });
  transports.last.emit({
    v: WIRE_VERSION,
    type: "agent_event",
    sessionId: "s1",
    seq: 7,
    event: {
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "half a th" },
    },
  });

  transports.last.drop();
  await scheduler.runNext();
  transports.last.acceptHello([summary({ sessionId: "s1", leafId: "e1" })]);

  const [entries] = transports.last.sentOfType("get_entries");
  assert.equal(entries?.since, "e1", "resumed from the durable cursor");
  const [subscribe] = transports.last.sentOfType("subscribe");
  assert.equal(subscribe?.sinceSeq, 7, "tailed from the live cursor");
});

test("a moved branch triggers a full refetch, not a patch", async () => {
  const { transports, client } = setup();
  await flush();
  transports.last.acceptHello([summary({ sessionId: "s1" })]);
  client.watch("s1");
  transports.last.emit({
    v: WIRE_VERSION,
    type: "entries",
    sessionId: "s1",
    entries: [entry("e1"), entry("e2", "e1")],
    leafId: "e2",
    reset: false,
    offset: 0,
    total: 0,
  });

  // Someone forked the session from another client while we were away.
  transports.last.drop();
  await flush();
  supervisorWake(client);
  await flush();
  transports.last.acceptHello([summary({ sessionId: "s1", leafId: "forked-9" })]);

  const entriesFrames = transports.last.sentOfType("get_entries");
  assert.equal(entriesFrames.at(-1)?.since, undefined, "asked for the whole session");
  assert.equal(client.sessions.get("s1").entries.length, 0, "the stale cache was dropped");
});

test("a reported gap rebuilds the live transcript", async () => {
  const { transports, client } = setup();
  await flush();
  transports.last.acceptHello([summary({ sessionId: "s1" })]);
  client.watch("s1");

  client.sessions.applyEvent("s1", 4, {
    type: "message_update",
    assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "stale" },
  });
  transports.last.emit({
    v: WIRE_VERSION,
    type: "subscribed",
    sessionId: "s1",
    seq: 99,
    gap: true,
  });

  assert.equal(client.sessions.transcript("s1").streaming, null);
  assert.equal(client.sessions.lastSeq("s1"), 0);
});

test("the daemon's live cursor replaces one left over from another process", async () => {
  const { transports, client } = setup();
  await flush();
  transports.last.acceptHello([summary({ sessionId: "s1" })]);
  client.watch("s1");
  client.sessions.applyEvent("s1", 900, { type: "agent_start" });

  transports.last.emit({ v: WIRE_VERSION, type: "subscribed", sessionId: "s1", seq: 3, gap: false });

  assert.equal(client.sessions.lastSeq("s1"), 3, "tails the restarted counter");
});

test("prompts queue while disconnected and drain on reconnect", async () => {
  const { scheduler, transports, client } = setup();
  await flush();
  transports.last.acceptHello([summary({ sessionId: "s1" })]);
  transports.last.drop();

  // Composed with no connection at all: the whole point of the outbox.
  const queued = client.prompt({ sessionId: "s1", text: "written offline" });
  assert.equal(client.outbox.pendingCount, 1);

  // The supervisor and the outbox each hold their own timer, so step until
  // the reconnect attempt is the one that fires.
  while (transports.created.length < 2) await scheduler.runNext();
  transports.last.acceptHello([summary({ sessionId: "s1" })]);

  const [prompt] = transports.last.sentOfType("prompt");
  assert.equal(prompt?.text, "written offline");
  assert.equal(prompt?.commandId, queued.commandId);

  transports.last.emit({
    v: WIRE_VERSION,
    type: "ack",
    commandId: queued.commandId,
    duplicate: false,
  });
  assert.equal(client.outbox.pendingCount, 0);
});

test("a prompt survives the app being killed and is redelivered once", async () => {
  const storage = new MemoryStorage();
  const first = setup(storage);
  await flush();
  first.transports.last.acceptHello([summary({ sessionId: "s1" })]);
  first.transports.last.drop();
  const queued = first.client.prompt({ sessionId: "s1", text: "survive me" });

  // App killed. Only storage carries over.
  const second = setup(storage.clone());
  await flush();
  second.transports.last.acceptHello([summary({ sessionId: "s1" })]);

  const prompts = second.transports.last.sentOfType("prompt");
  assert.equal(prompts.length, 1);
  assert.equal(prompts[0]!.text, "survive me");
  assert.equal(prompts[0]!.commandId, queued.commandId, "same idempotency key as before");
});

test("a duplicate ack still clears the entry", async () => {
  const { transports, client } = setup();
  await flush();
  transports.last.acceptHello([summary({ sessionId: "s1" })]);
  const queued = client.prompt({ sessionId: "s1", text: "once" });

  transports.last.emit({
    v: WIRE_VERSION,
    type: "ack",
    commandId: queued.commandId,
    duplicate: true,
  });
  assert.equal(client.outbox.list().length, 0);
});

test("a rejected prompt is kept for the user without faking a stale transcript", async () => {
  const { transports, client } = setup();
  await flush();
  transports.last.acceptHello([summary({ sessionId: "s1" })]);
  const queued = client.prompt({ sessionId: "s1", text: "while busy" });

  transports.last.emit({
    v: WIRE_VERSION,
    type: "error",
    commandId: queued.commandId,
    code: "agent_busy",
    message: "Specify streamingBehavior",
  });

  const entryAfter = client.outbox.list()[0]!;
  assert.equal(entryAfter.status, "failed");
  assert.equal(client.supervisor.getState().transport, "connected", "still a healthy socket");
  // The rejection says nothing about the transcript, so sync is untouched;
  // the failure is visible on the outbox entry itself.
  assert.notEqual(client.supervisor.getState().sync, "error");
});

test("a rejected one-off command is reported, not turned into a sync error", async () => {
  const { transports, client } = setup();
  await flush();
  transports.last.acceptHello([summary({ sessionId: "s1" })]);

  const seen: string[] = [];
  client.onCommandError((error) => seen.push(error.message));
  client.setSessionTrust("s1", true);
  const sent = transports.last.sentOfType("set_session_trust")[0]!;
  transports.last.emit({
    v: WIRE_VERSION,
    type: "error",
    commandId: sent.commandId,
    code: "bad_request",
    message: "unknown frame",
  });

  assert.deepEqual(seen, ["unknown frame"]);
  assert.notEqual(client.supervisor.getState().sync, "error");
});

test("a failed resync is still a sync error", async () => {
  const { transports, client } = setup();
  await flush();
  transports.last.acceptHello([summary({ sessionId: "s1" })]);
  client.watch("s1");
  const sent = transports.last.sentOfType("get_entries")[0]!;
  transports.last.emit({
    v: WIRE_VERSION,
    type: "error",
    commandId: sent.commandId,
    code: "unknown_session",
    message: "gone",
  });

  assert.equal(client.supervisor.getState().sync, "error");
});

test("recovery from a daemon crash refetches when the leaf rewound", async () => {
  const { transports, client } = setup();
  await flush();
  transports.last.acceptHello([summary({ sessionId: "s1" })]);
  client.watch("s1");
  transports.last.emit({
    v: WIRE_VERSION,
    type: "entries",
    sessionId: "s1",
    entries: [entry("e1"), entry("e2", "e1")],
    leafId: "e2",
    reset: false,
    offset: 0,
    total: 0,
  });

  // The daemon restarted pi; the half-streamed turn was never persisted.
  transports.last.emit({
    v: WIRE_VERSION,
    type: "session_recovered",
    sessionId: "s1",
    leafId: "rewound-1",
    reason: "pi exited (code 9)",
  });

  assert.equal(client.sessions.get("s1").entries.length, 0);
  assert.equal(transports.last.sentOfType("get_entries").at(-1)?.since, undefined);
});

test("a session command with no live socket is reported, not silently dropped", async () => {
  const { transports, client } = setup();
  await flush();
  transports.last.acceptHello([]);
  assert.equal(client.listSessions({ query: "anything" }), true);

  transports.last.drop(1006, "gone");
  await flush();
  assert.equal(client.listSessions({ query: "anything" }), false);
  assert.equal(client.interrupt("s1"), false);
});

test("only blocking dialogs become sheets; presentation requests are not", async () => {
  const { transports, client } = setup();
  await flush();
  transports.last.acceptHello([summary({ sessionId: "s1", leafId: null })]);

  transports.last.emit({
    v: WIRE_VERSION,
    type: "extension_ui_request",
    sessionId: "s1",
    // Extensions set a status line on every session start. It answers nothing
    // and must not put an unanswerable card in front of the transcript.
    request: { type: "extension_ui_request", id: "r1", method: "setStatus", statusKey: "nolo" },
  });
  assert.deepEqual(client.sessions.openDialogs("s1"), []);

  transports.last.emit({
    v: WIRE_VERSION,
    type: "extension_ui_request",
    sessionId: "s1",
    request: { type: "extension_ui_request", id: "r2", method: "confirm", title: "Apply edit?" },
  });
  assert.equal(client.sessions.openDialogs("s1").length, 1);

  client.answerDialog("s1", "r2", { confirmed: true });
  const [answer] = transports.last.sentOfType("extension_ui_response");
  assert.equal(answer?.requestId, "r2");
  // Closed on send: the sheet must not linger while the agent unblocks.
  assert.deepEqual(client.sessions.openDialogs("s1"), []);
});

test("session stats are asked for and cached per session", async () => {
  const { transports, client } = setup();
  await flush();
  transports.last.acceptHello([summary({ sessionId: "s1" })]);

  const seen: string[] = [];
  client.onStats((sessionId) => seen.push(sessionId));
  client.requestStats("s1");
  assert.equal(transports.last.sentOfType("get_stats").length, 1);

  transports.last.emit({
    v: WIRE_VERSION,
    type: "session_stats",
    sessionId: "s1",
    stats: { cost: 0.5, tokens: { total: 2400 } },
  });
  assert.equal(client.getStats("s1")?.cost, 0.5);
  assert.deepEqual(seen, ["s1"]);
  assert.equal(client.getStats("s2"), null, "another session has its own numbers");

  assert.equal(client.getStats("s2"), null, "and never borrows another's");
});

test("slash commands are asked for and cached per session", async () => {
  const { transports, client } = setup();
  await flush();
  transports.last.acceptHello([summary({ sessionId: "s1" })]);

  client.listCommands("s1");
  assert.equal(transports.last.sentOfType("list_commands").length, 1);

  transports.last.emit({
    v: WIRE_VERSION,
    type: "commands",
    sessionId: "s1",
    commands: [{ name: "review:1", source: "extension" }],
  });
  assert.deepEqual(
    client.getCommands("s1").map((command) => command.name),
    ["review:1"],
  );
  assert.deepEqual(client.getCommands("s2"), [], "another session has its own list");

  assert.deepEqual(client.getCommands("s2"), [], "and never borrows another's");
});

test("a bash run streams into the view and is held until its entry lands", async () => {
  const { transports, client } = setup();
  await flush();
  transports.last.acceptHello([summary({ sessionId: "s1", leafId: null })]);
  client.watch("s1");

  client.runBash("s1", "ls", true);
  const [sent] = transports.last.sentOfType("run_bash");
  assert.equal(sent?.command, "ls");
  assert.equal(sent?.excludeFromContext, true);

  transports.last.emit({
    v: WIRE_VERSION,
    type: "bash_state",
    sessionId: "s1",
    command: "ls",
    excludeFromContext: true,
    running: true,
  });
  transports.last.emit({
    v: WIRE_VERSION,
    type: "agent_event",
    sessionId: "s1",
    seq: 3,
    event: { type: "bash_execution_update", delta: "a\n" },
  });
  assert.equal(client.sessions.bash("s1")?.output, "a\n");
  assert.equal(client.sessions.bash("s1")?.running, true);

  transports.last.emit({
    v: WIRE_VERSION,
    type: "bash_state",
    sessionId: "s1",
    command: "ls",
    excludeFromContext: true,
    running: false,
    result: { output: "a\nb\n", exitCode: 0, cancelled: false, truncated: false },
  });
  assert.equal(client.sessions.bash("s1")?.running, false);
  assert.equal(client.sessions.bash("s1")?.output, "a\nb\n", "the result supersedes the deltas");
  assert.equal(
    transports.last.sentOfType("get_entries").length,
    2,
    "no agent_settled follows a bare command, so the entry is fetched here",
  );

  transports.last.emit({
    v: WIRE_VERSION,
    type: "entries",
    sessionId: "s1",
    entries: [
      {
        id: "e1",
        parentId: null,
        type: "message",
        message: { role: "bashExecution", command: "ls", output: "a\nb\n", exitCode: 0 },
      },
    ],
    leafId: "e1",
    reset: false,
    offset: 0,
    total: 0,
  });
  assert.equal(client.sessions.bash("s1"), null, "the persisted entry takes over the card");
});

test("a draft's first prompt carries what it takes to create the session", async () => {
  const { transports, client } = setup();
  await flush();
  transports.last.acceptHello([]);

  const draftId = client.newSessionId();
  client.prompt({
    sessionId: draftId,
    text: "start here",
    create: { cwd: "/tmp/project", trustProject: true },
  });
  await flush();

  const sent = transports.last.sentOfType("prompt").at(-1);
  assert.equal(sent?.sessionId, draftId, "the session takes the id composed against");
  assert.deepEqual(sent?.create, { cwd: "/tmp/project", trustProject: true });
});

test("a queued draft survives a restart with its directory attached", async () => {
  const storage = new MemoryStorage();
  const first = setup(storage);
  await flush();
  // No socket yet: this is the train case, composed offline and sent later.
  first.client.prompt({
    sessionId: "draft-1",
    text: "later",
    create: { cwd: "/tmp/project" },
  });
  await flush();

  const second = setup(storage);
  await flush();
  second.transports.last.acceptHello([]);
  await flush();

  const sent = second.transports.last.sentOfType("prompt").at(-1);
  assert.equal(sent?.text, "later");
  assert.deepEqual(sent?.create, { cwd: "/tmp/project", trustProject: false });
});

test("the last session list is shown before the socket is up", async () => {
  const storage = new MemoryStorage();
  const first = setup(storage);
  await flush();
  first.transports.last.acceptHello([]);
  first.transports.last.emit({
    v: WIRE_VERSION,
    type: "sessions",
    sessions: [summary({ sessionId: "s1", cwd: "/tmp/project" })],
    offset: 0,
    total: 1,
    hasMore: false,
  });

  const second = setup(storage);
  assert.deepEqual(
    second.client.supervisor.getState().sessions.map((s) => s.sessionId),
    ["s1"],
    "rendered from the cache, never trusted for freshness",
  );
});
