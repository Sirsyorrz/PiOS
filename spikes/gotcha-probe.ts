/**
 * Phase 0 spike, step 4: probe the four documented gotchas explicitly.
 *
 *   a. trust fallback in RPC mode (defaultProjectTrust / --approve)
 *   b. streamingBehavior required while the agent streams
 *   c. message_update delta assembly reproduces message_end.message
 *   d. agent_settled vs agent_end ordering
 *
 * Run: pnpm spike:gotchas
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { RpcProbe, type Json } from "./rpc.ts";

const TRACES = new URL("./traces/", import.meta.url).pathname;
const SESSIONS = new URL("./.sessions/", import.meta.url).pathname;
const SANDBOX = new URL("./.trust-sandbox/", import.meta.url).pathname;
const MODEL = ["--provider", "anthropic", "--model", "claude-haiku-4-5"];

const findings: string[] = [];
function note(s: string) {
  findings.push(s);
  console.log("  . " + s);
}

function args(extra: string[] = []) {
  return [...MODEL, "--session-dir", SESSIONS, "--session-id", randomUUID(), "-nc", ...extra];
}

function setupTrustSandbox() {
  mkdirSync(`${SANDBOX}.pi/prompts`, { recursive: true });
  writeFileSync(
    `${SANDBOX}.pi/prompts/pios-trust-marker.md`,
    "---\ndescription: PiOS project-local trust marker\n---\nmarker\n",
  );
}

async function probeTrust() {
  console.log("\n== a: project-local trust ==");
  const hasMarker = async (extra: string[]) => {
    const pi = new RpcProbe(args(extra), undefined, { cwd: SANDBOX });
    const res = await pi.send({ type: "get_commands" });
    const names: string[] = res.data.commands.map((c: Json) => c.name);
    pi.kill("SIGTERM");
    await pi.exited;
    return names.includes("pios-trust-marker");
  };

  const untrusted = await hasMarker([]);
  const approved = await hasMarker(["--approve"]);
  const denied = await hasMarker(["--no-approve"]);
  note(`project-local prompt template visible, no flag:     ${untrusted}`);
  note(`project-local prompt template visible, --approve:    ${approved}`);
  note(`project-local prompt template visible, --no-approve: ${denied}`);
  note(
    untrusted
      ? "RPC mode loaded project-local resources with no flag on this machine, so trust is not automatically `never` headless"
      : "RPC mode silently drops project-local resources unless trusted",
  );
  note("--approve / --no-approve are per-run and decisive, so PiOS must carry a trust flag per session and surface it");
}

async function probeStreamingAndAssembly() {
  console.log("\n== b/c/d: streamingBehavior, delta assembly, settle ordering ==");
  const pi = new RpcProbe(args(["-ns", "-ne", "-np"]), `${TRACES}streaming.jsonl`, { cwd: SANDBOX });

  // c: assemble partials the way a client must, from message_start + contentIndex.
  const parts = new Map<number, string>();
  const toolArgs = new Map<string, string>();
  let started = 0;
  let final: Json | null = null;
  const order: string[] = [];
  pi.on((e) => {
    order.push(e.type);
    if (e.type === "message_start") {
      started++;
      parts.clear();
    }
    if (e.type === "message_update") {
      const ev = e.assistantMessageEvent;
      if (ev?.type === "text_delta" || ev?.type === "thinking_delta") {
        parts.set(ev.contentIndex, (parts.get(ev.contentIndex) ?? "") + ev.delta);
      }
      if (ev?.type === "toolcall_delta") {
        toolArgs.set(ev.toolCallId ?? "unknown", (toolArgs.get(ev.toolCallId ?? "unknown") ?? "") + ev.delta);
      }
    }
    if (e.type === "message_end" && e.message?.role === "assistant") final = e.message;
  });

  const settled = pi.next("agent_settled");
  const queueUpdates: Json[] = [];
  pi.on((e) => {
    if (e.type === "queue_update") queueUpdates.push(e);
  });

  await pi.send({
    type: "prompt",
    message: "Write a haiku about JSONL framing, then stop.",
  });

  // b: while streaming, a bare prompt must be rejected.
  await pi.next("message_start");
  const bare = await pi.send({ type: "prompt", message: "ignored" });
  note(`bare prompt during streaming -> success=${bare.success}, error=${JSON.stringify(bare.error ?? null)}`);
  const steered = await pi.send({
    type: "prompt",
    message: "Also mention U+2028.",
    streamingBehavior: "steer",
  });
  note(`prompt with streamingBehavior:"steer" during streaming -> success=${steered.success}`);

  await settled;
  note(`queue_update events observed: ${queueUpdates.length}`);

  const assembled = [...parts.entries()].sort((a, b) => a[0] - b[0]).map(([, v]) => v).join("");
  const authoritative = ((final as any)?.content ?? [])
    .filter((c: Json) => c.type === "text" || c.type === "thinking")
    .map((c: Json) => c.text ?? c.thinking)
    .join("");
  note(`message_start seen ${started}x; assembled ${assembled.length} chars from deltas`);
  note(
    assembled === authoritative
      ? "delta assembly === message_end.message content (exact)"
      : `delta assembly DIFFERS from message_end (${assembled.length} vs ${authoritative.length}) -> message_end is authoritative`,
  );

  const endIdx = order.lastIndexOf("agent_end");
  const settledIdx = order.lastIndexOf("agent_settled");
  const endsBefore = order.filter((t) => t === "agent_end").length;
  note(`agent_end fired ${endsBefore}x before a single agent_settled (end@${endIdx} < settled@${settledIdx}: ${endIdx < settledIdx})`);

  pi.kill("SIGTERM");
  await pi.exited;
}

async function main() {
  mkdirSync(TRACES, { recursive: true });
  mkdirSync(SESSIONS, { recursive: true });
  setupTrustSandbox();
  await probeTrust();
  await probeStreamingAndAssembly();
  console.log("\n== findings ==");
  for (const f of findings) console.log("- " + f);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
