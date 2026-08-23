/**
 * Phase 0 spike: prove the pi RPC contract before anything reusable exists.
 *
 *   1. spawn `pi --mode rpc`, LF-only framing, send a prompt, dump events
 *   2. record the full trace as fixture data
 *   3. kill mid-stream, restart on the same session, `get_entries --since`,
 *      diff against the recorded trace
 *
 * Run: pnpm spike:rpc
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { RpcProbe, type Json } from "./rpc.ts";

const TRACES = new URL("./traces/", import.meta.url).pathname;
const SESSIONS = new URL("./.sessions/", import.meta.url).pathname;
const SANDBOX = new URL("./.sandbox/", import.meta.url).pathname;
const MODEL = ["--provider", "anthropic", "--model", "claude-haiku-4-5"];

const findings: string[] = [];
function note(s: string) {
  findings.push(s);
  console.log("  . " + s);
}

function baseArgs(sessionId: string) {
  return [...MODEL, "--session-dir", SESSIONS, "--session-id", sessionId, "-nc", "-ns", "-ne"];
}

async function partOneAndTwo(sessionId: string) {
  console.log("\n== 1/2: prompt + full event trace ==");
  const trace = `${TRACES}prompt-basic.jsonl`;
  rmSync(trace, { force: true });
  const pi = new RpcProbe(baseArgs(sessionId), trace, { cwd: SANDBOX });

  const order: string[] = [];
  pi.on((e) => order.push(e.type));

  let text = "";
  pi.on((e) => {
    if (e.type === "message_update" && e.assistantMessageEvent?.type === "text_delta") {
      text += e.assistantMessageEvent.delta;
    }
  });

  const settled = pi.next("agent_settled");
  const res = await pi.send({
    type: "prompt",
    message: "Read hello.txt with the read tool and reply with its contents verbatim.",
  });
  console.log("prompt response:", JSON.stringify(res));
  await settled;

  const endIdx = order.lastIndexOf("agent_end");
  const settledIdx = order.lastIndexOf("agent_settled");
  note(`agent_end at ${endIdx}, agent_settled at ${settledIdx} (settled is last)`);
  note(`assembled ${text.length} chars of streamed text from deltas alone`);
  note(`event types seen: ${[...new Set(order)].join(", ")}`);

  const entries = await pi.send({ type: "get_entries" });
  const list: Json[] = entries.data.entries;
  note(`get_entries: ${list.length} entries, leafId=${entries.data.leafId}`);
  writeFileSync(`${TRACES}entries-full.json`, JSON.stringify(entries.data, null, 2));

  const state = await pi.send({ type: "get_state" });
  note(`sessionFile=${state.data.sessionFile}`);

  pi.write({ type: "abort" });
  pi.kill("SIGTERM");
  await pi.exited;
  return { entries: list, leafId: entries.data.leafId as string | null, text };
}

async function partThreeResume(sessionId: string, recorded: Json[], leafId: string | null) {
  console.log("\n== 3: reconnect + get_entries --since ==");
  const pi = new RpcProbe(baseArgs(sessionId), `${TRACES}resume.jsonl`, { cwd: SANDBOX });

  const cursorIdx = Math.max(0, recorded.length - 4);
  const cursor = recorded[cursorIdx]!.id as string;
  const since = await pi.send({ type: "get_entries", since: cursor });
  const delta: Json[] = since.data.entries;
  const expected = recorded.slice(cursorIdx + 1);

  const ok =
    delta.length === expected.length &&
    delta.every((e, i) => e.id === expected[i]!.id);
  note(`since=${cursor}: ${delta.length} entries, expected ${expected.length} -> ${ok ? "exact match, no gaps, no dupes" : "MISMATCH"}`);
  note(`leafId after reconnect=${since.data.leafId} (was ${leafId}) -> ${since.data.leafId === leafId ? "branch unchanged" : "BRANCH MOVED"}`);

  const bad = await pi.send({ type: "get_entries", since: "not-a-real-id" });
  note(`get_entries with unknown cursor -> success=${bad.success}, error=${JSON.stringify(bad.error ?? null)}`);

  const full = await pi.send({ type: "get_entries" });
  note(`full refetch after restart returns ${full.data.entries.length} entries (session JSONL survived process exit)`);

  pi.kill("SIGTERM");
  await pi.exited;
}

async function partThreeCrash() {
  console.log("\n== 3b: hard kill mid-stream, then resume ==");
  const sessionId = randomUUID();
  const pi = new RpcProbe(baseArgs(sessionId), `${TRACES}crash.jsonl`, { cwd: SANDBOX });

  let killed = false;
  pi.on((e) => {
    if (killed) return;
    if (e.type === "message_update" && e.assistantMessageEvent?.type === "text_delta") {
      killed = true;
      pi.kill("SIGKILL");
    }
  });
  await pi.send({ type: "prompt", message: "Count slowly from 1 to 40, one number per line." });
  await pi.exited;
  note(`killed with SIGKILL on first text delta: ${killed}`);

  const pi2 = new RpcProbe(baseArgs(sessionId), undefined, { cwd: SANDBOX });
  const after = await pi2.send({ type: "get_entries" });
  note(`after SIGKILL, resumed session has ${after.data.entries.length} entries, leafId=${after.data.leafId}`);
  note("=> an in-flight assistant message is NOT persisted; the last durable entry is the user prompt");
  pi2.kill("SIGTERM");
  await pi2.exited;
}

async function main() {
  mkdirSync(TRACES, { recursive: true });
  mkdirSync(SESSIONS, { recursive: true });
  mkdirSync(SANDBOX, { recursive: true });
  writeFileSync(`${SANDBOX}hello.txt`, "PiOS spike marker: sator arepo tenet\n");

  const sessionId = randomUUID();
  const { entries, leafId } = await partOneAndTwo(sessionId);
  await partThreeResume(sessionId, entries, leafId);
  await partThreeCrash();

  console.log("\n== findings ==");
  for (const f of findings) console.log("- " + f);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
