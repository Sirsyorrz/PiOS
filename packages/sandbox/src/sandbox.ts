import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { projectSessionDir, subprocessHost } from "@pios/pi-host";
import { PiosServer } from "@pios/server";
import { createRepo } from "./repo.ts";
import { buildEntries } from "./transcript.ts";
import { findScenario } from "./scenarios/index.ts";
import type { Scenario, SessionSpec } from "./scenario.ts";

// The stub pi and its session-file writer live with the host's contract tests,
// which are the things that keep them honest about pi's actual behaviour.
const FAKE_PI = fileURLToPath(new URL("../../pi-host/test/fake-pi.ts", import.meta.url));
const { branchFakeSession } = await import("../../pi-host/test/fake-branch.ts");

export interface SandboxOptions {
  scenario?: string | Scenario;
  host?: string;
  port?: number;
  /** Built PWA to serve from the daemon itself. Null means API only. */
  webDir?: string | null;
}

export interface SandboxSession {
  id: string;
  name: string;
  cwd: string;
}

export interface Sandbox {
  server: PiosServer;
  scenario: Scenario;
  /** Origin of the daemon. The dev server proxies to it. */
  baseUrl: string;
  deviceToken: string;
  dir: string;
  sessions: SandboxSession[];
  close(): Promise<void>;
}

/**
 * A whole PiOS stack over the loopback, backed by the stub pi.
 *
 * Same server code the daemon runs, so what is observed here is the real
 * protocol, auth and git handling; only the agent is fake. Everything it
 * writes lives under one temp directory that is removed on close, which is
 * what makes it safe to point at a scenario that dirties a git repo.
 */
export async function startSandbox(options: SandboxOptions = {}): Promise<Sandbox> {
  const scenario =
    typeof options.scenario === "object"
      ? options.scenario
      : findScenario(options.scenario ?? "chat");

  const dir = mkdtempSync(join(tmpdir(), "pios-sandbox-"));
  const sessionRoot = join(dir, "sessions");
  const projects = join(dir, "projects");
  mkdirSync(projects, { recursive: true });

  const sessions = scenario.sessions.map((spec) => seed(spec, projects, sessionRoot));

  const server = new PiosServer({
    host: options.host ?? "127.0.0.1",
    port: options.port ?? 0,
    dataDir: join(dir, "data"),
    sessionDir: sessionRoot,
    // Never the developer's own: trust decisions are read and written here.
    agentDir: join(dir, "agent"),
    sessionIdleMs: scenario.sessionIdleMs ?? 30 * 60_000,
    piVersion: "sandbox",
    webDir: options.webDir === undefined ? null : options.webDir,
    sessionHost: subprocessHost({
      command: process.execPath,
      argsPrefix: [FAKE_PI],
      sessionDir: sessionRoot,
      // Empty: a sandbox must not inherit the developer's own model scope.
      agentDir: join(dir, "agent"),
      branchSessionFile: branchFakeSession,
      requestTimeoutMs: 5_000,
    }),
  });
  await server.listen();

  const baseUrl = `http://127.0.0.1:${server.port}`;
  const deviceToken = await pair(baseUrl, server);

  for (const session of sessions) {
    await server.registry.create({ id: session.id, cwd: session.cwd, name: session.name });
  }
  // A scenario that asks for reaping gets it now, rather than after a wait
  // nobody watching a screenshot is going to sit through.
  if (scenario.sessionIdleMs !== undefined) await server.registry.sweep();

  return {
    server,
    scenario,
    baseUrl,
    deviceToken,
    dir,
    sessions,
    close: async () => {
      await server.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** Writes the session's repo and its transcript where the stub pi will find it. */
function seed(spec: SessionSpec, projects: string, sessionRoot: string): SandboxSession {
  const cwd = createRepo(join(projects, spec.id), spec.repo);
  const stateDir = projectSessionDir(cwd, sessionRoot);
  mkdirSync(stateDir, { recursive: true });
  const entries = buildEntries(spec.id, spec.entries ?? []);
  writeFileSync(join(stateDir, `${spec.id}.json`), JSON.stringify(entries));
  return { id: spec.id, name: spec.name, cwd };
}

async function pair(baseUrl: string, server: PiosServer): Promise<string> {
  const { token } = server.auth.createPairing();
  const response = await fetch(`${baseUrl}/pair`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ pairingToken: token, label: "sandbox" }),
  });
  if (!response.ok) throw new Error(`sandbox pairing failed (${response.status})`);
  return ((await response.json()) as { deviceToken: string }).deviceToken;
}
