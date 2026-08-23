/**
 * Phase 0 spike, step 5: same probe against the in-process AgentSession, to
 * decide which host v0 uses.
 *
 * Run: pnpm spike:inproc
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { createAgentSession, SessionManager } from "@earendil-works/pi-coding-agent";

const SANDBOX = new URL("./.sandbox/", import.meta.url).pathname;
const SESSIONS = new URL("./.sessions-inproc/", import.meta.url).pathname;

const findings: string[] = [];
function note(s: string) {
  findings.push(s);
  console.log("  . " + s);
}

async function main() {
  mkdirSync(SANDBOX, { recursive: true });
  mkdirSync(SESSIONS, { recursive: true });
  writeFileSync(`${SANDBOX}hello.txt`, "PiOS spike marker: sator arepo tenet\n");

  const t0 = Date.now();
  const { session } = await createAgentSession({
    cwd: SANDBOX,
    sessionManager: SessionManager.create(SANDBOX, SESSIONS),
  });
  note(`createAgentSession took ${Date.now() - t0}ms (no process spawn, no stdio)`);
  note(`model=${session.model?.provider}/${session.model?.id}`);

  const types: string[] = [];
  let text = "";
  const settled = new Promise<void>((resolve) => {
    session.subscribe((e: any) => {
      types.push(e.type);
      if (e.type === "message_update" && e.assistantMessageEvent?.type === "text_delta") {
        text += e.assistantMessageEvent.delta;
      }
      if (e.type === "agent_settled") resolve();
    });
  });

  await session.prompt("Read hello.txt with the read tool and reply with its contents verbatim.");
  await settled;

  note(`event types: ${[...new Set(types)].join(", ")}`);
  note(`streamed ${text.length} chars; event shape is identical to RPC mode (same AgentSessionEvent union)`);

  const entries = session.sessionManager.getEntries();
  const leafId = session.sessionManager.getLeafId();
  note(`sessionManager.getEntries(): ${entries.length} entries, leafId=${leafId}`);
  note("no `since` cursor in-process: getEntries() returns everything, the host must slice by entry id itself");
  note(`sessionFile=${session.sessionFile}`);

  session.dispose();
  console.log("\n== findings ==");
  for (const f of findings) console.log("- " + f);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
