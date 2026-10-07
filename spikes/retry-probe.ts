/**
 * Records how pi reports provider failures, against a local endpoint that
 * answers every request with 429. No API key, no tokens spent.
 *
 *   1. retries run out: `auto_retry_start` per attempt, then a failed
 *      `auto_retry_end` with `finalError`
 *   2. `abort_retry` during the backoff wait
 *
 * Run: pnpm spike:retry
 */
import { createServer } from "node:http";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { RpcProbe } from "./rpc.ts";

const TRACES = new URL("./traces/", import.meta.url).pathname;
const SESSIONS = new URL("./.sessions/", import.meta.url).pathname;
const SANDBOX = new URL("./.sandbox/", import.meta.url).pathname;
const AGENT_DIR = new URL("./.retry-agent/", import.meta.url).pathname;

const server = createServer((req, res) => {
  req.resume();
  req.on("end", () => {
    res.writeHead(429, { "content-type": "application/json", "retry-after": "0" });
    res.end(JSON.stringify({ error: { message: "Rate limit reached for requests", type: "rate_limit" } }));
  });
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = (server.address() as AddressInfo).port;

function configure(baseDelayMs: number) {
  rmSync(AGENT_DIR, { recursive: true, force: true });
  mkdirSync(AGENT_DIR, { recursive: true });
  writeFileSync(
    `${AGENT_DIR}models.json`,
    JSON.stringify({
      providers: {
        flaky: {
          baseUrl: `http://127.0.0.1:${port}/v1`,
          api: "openai-completions",
          apiKey: "unused",
          models: [{ id: "flaky-1" }],
        },
      },
    }),
  );
  writeFileSync(
    `${AGENT_DIR}settings.json`,
    JSON.stringify({ retry: { enabled: true, maxRetries: 2, baseDelayMs, provider: { maxRetries: 0 } } }),
  );
}

function start(trace: string) {
  rmSync(trace, { force: true });
  mkdirSync(SANDBOX, { recursive: true });
  process.env.PI_CODING_AGENT_DIR = AGENT_DIR;
  const args = [
    "--provider", "flaky", "--model", "flaky-1",
    "--session-dir", SESSIONS, "--session-id", randomUUID(),
    "-nc", "-ns", "-ne",
  ];
  return new RpcProbe(args, trace, { cwd: SANDBOX });
}

async function exhausted() {
  console.log("\n== 1/2: retries run out ==");
  configure(20);
  const pi = start(`${TRACES}rate-limit.jsonl`);
  const settled = pi.next("agent_settled");
  await pi.send({ type: "prompt", message: "hello" });
  await settled;
  await pi.send({ type: "get_entries" });
  pi.kill("SIGTERM");
  await pi.exited;
}

async function cancelled() {
  console.log("\n== 2/2: abort_retry during the wait ==");
  configure(60_000);
  const pi = start(`${TRACES}rate-limit-abort.jsonl`);
  const retrying = pi.next("auto_retry_start");
  const settled = pi.next("agent_settled");
  await pi.send({ type: "prompt", message: "hello" });
  await retrying;
  await pi.send({ type: "abort_retry" });
  await settled;
  pi.kill("SIGTERM");
  await pi.exited;
}

try {
  await exhausted();
  await cancelled();
} finally {
  server.close();
  rmSync(AGENT_DIR, { recursive: true, force: true });
}
console.log("\ntraces written to", TRACES);
