/**
 * Manual driver: two concurrent sessions on one registry.
 *
 *   node test/driver.ts          two stub sessions, free and offline
 *   PIOS_DRIVER_REAL=1 node test/driver.ts   two real `pi --mode rpc` sessions
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { SessionRegistry, subprocessHost } from "../src/registry.ts";
import type { PiSession } from "../src/types.ts";

const real = process.env.PIOS_DRIVER_REAL === "1";
const dir = mkdtempSync(join(tmpdir(), "pios-driver-"));
const FAKE_PI = fileURLToPath(new URL("./fake-pi.ts", import.meta.url));

const registry = new SessionRegistry(
  subprocessHost(
    real
      ? { sessionDir: dir }
      : { command: process.execPath, argsPrefix: [FAKE_PI], sessionDir: dir },
  ),
);

function watch(session: PiSession, label: string) {
  session.subscribe((buffered) => {
    const event = buffered.event;
    if (event.type === "status") {
      console.log(`\n[${label}] status -> ${event.status}`);
      return;
    }
    if (event.type === "session_recovered") {
      console.log(`\n[${label}] recovered (${event.reason}), leaf=${event.leafId}`);
      return;
    }
    if (event.type !== "agent_event") return;
    const agentEvent = event.event;
    if (
      agentEvent.type === "message_update" &&
      agentEvent.assistantMessageEvent.type === "text_delta"
    ) {
      process.stdout.write(`[${label}] ${agentEvent.assistantMessageEvent.delta}`);
    }
    if (agentEvent.type === "agent_settled") console.log(`\n[${label}] settled`);
  });
}

function settled(session: PiSession): Promise<void> {
  return new Promise((resolve) => {
    const off = session.subscribe((buffered) => {
      if (buffered.event.type !== "agent_event") return;
      if (buffered.event.event.type !== "agent_settled") return;
      off();
      resolve();
    });
  });
}

const alpha = await registry.create({ id: "alpha", cwd: process.cwd(), name: "alpha" });
const beta = await registry.create({ id: "beta", cwd: process.cwd(), name: "beta" });
watch(alpha, "alpha");
watch(beta, "beta");

await Promise.all([
  alpha.prompt("say the word alpha").then(() => settled(alpha)),
  beta.prompt("say the word beta").then(() => settled(beta)),
]);

for (const session of [alpha, beta]) {
  const page = await session.getEntries();
  console.log(
    `${session.info.name}: ${page.entries.length} entries, leaf=${page.leafId}, buffered=${session.replay().events.length}`,
  );
}

console.table(registry.list().map((s) => ({ id: s.id, status: s.status, leaf: s.leafId })));
await registry.disposeAll();
