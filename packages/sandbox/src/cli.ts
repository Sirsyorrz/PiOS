#!/usr/bin/env node
import { spawn, type ChildProcess } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Browser, PHONE_VIEWPORT } from "./browser.ts";
import { startSandbox, type Sandbox } from "./sandbox.ts";
import { findScenario, scenarios } from "./scenarios/index.ts";

const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const WEB_PORT = Number(process.env.PIOS_SANDBOX_WEB_PORT ?? 5173);
/** Fixed so one dev server can outlive a sequence of daemons. */
const API_PORT = Number(process.env.PIOS_SANDBOX_PORT ?? 4311);

const argv = process.argv.slice(2);
const command = argv[0] && !argv[0].startsWith("-") ? argv.shift()! : "up";
const flag = (name: string, fallback?: string) => {
  const index = argv.indexOf(`--${name}`);
  return index === -1 ? fallback : argv[index + 1];
};
const has = (name: string) => argv.includes(`--${name}`);
/** Repeatable, so a shot can be several taps deep into the app. */
const flags = (name: string) =>
  argv.flatMap((arg, i) => (arg === `--${name}` && argv[i + 1] ? [argv[i + 1]!] : []));

switch (command) {
  case "up":
    await up();
    break;
  case "shot":
    await shot();
    break;
  case "list":
    for (const s of scenarios) console.log(`  ${s.name.padEnd(16)} ${s.description}`);
    break;
  default:
    console.error("usage: pios-sandbox [up|shot|list] [--scenario <name>] [--headed]");
    process.exit(2);
}

/** Boots the stack and a dev server, then leaves them running. */
async function up(): Promise<void> {
  const sandbox = await startSandbox({ scenario: flag("scenario", "chat"), port: API_PORT });
  const vite = has("no-web") ? null : startWeb(sandbox.baseUrl, "inherit");

  report(sandbox, appUrl(sandbox));

  const shutdown = async () => {
    vite?.kill();
    await sandbox.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}

/**
 * Boots, screenshots, tears down.
 *
 * One command an agent can run after an edit. It drives the dev server, not a
 * build, so what is photographed is the source on disk right now.
 */
async function shot(): Promise<void> {
  const names = flag("scenario") ? [flag("scenario")!] : scenarios.map((s) => s.name);
  const outDir = flag("out", join(REPO_ROOT, ".sandbox/shots"))!;
  const target = `http://127.0.0.1:${API_PORT}`;
  const vite = startWeb(target, "ignore");
  const browser = await Browser.launch({ headless: !has("headed"), viewport: PHONE_VIEWPORT });

  try {
    await waitForWeb();
    for (const name of names) {
      const sandbox = await startSandbox({ scenario: findScenario(name), port: API_PORT });
      try {
        await browser.goto(appUrl(sandbox));
        await browser.waitFor("#root *");
        // Sessions arrive over the socket after the first paint.
        await browser.sleep(Number(flag("settle", "1200")));
        for (const label of flags("tap")) {
          if (!(await browser.tapText(label))) throw new Error(`nothing to tap matching "${label}"`);
          await browser.sleep(600);
        }
        console.log(`${name.padEnd(16)} ${await browser.screenshot(join(outDir, `${name}.png`))}`);
        if (has("text")) console.log(await browser.text("#root"));
      } finally {
        await sandbox.close();
      }
    }
  } finally {
    await browser.close();
    vite.kill();
  }
}

function startWeb(target: string, stdio: "inherit" | "ignore"): ChildProcess {
  return spawn("pnpm", ["-F", "@pios/web", "dev", "--port", String(WEB_PORT), "--strictPort"], {
    cwd: REPO_ROOT,
    stdio,
    // A machine-wide NODE_ENV=production would hand the dev server React's
    // production build and no HMR.
    env: { ...process.env, NODE_ENV: "development", PIOS_SANDBOX_TARGET: target },
  });
}

async function waitForWeb(timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await fetch(`http://127.0.0.1:${WEB_PORT}/`);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
  }
  throw new Error("dev server did not start");
}

/** The one URL that pairs the app and opens it, with no clicks in between. */
function appUrl(sandbox: Sandbox): string {
  return `http://localhost:${WEB_PORT}/?sandbox=1&token=${sandbox.deviceToken}`;
}

function report(sandbox: Sandbox, url: string): void {
  console.log(`\n  scenario   ${sandbox.scenario.name} - ${sandbox.scenario.description}`);
  console.log(`  daemon     ${sandbox.baseUrl}`);
  console.log(`  workdir    ${sandbox.dir}`);
  for (const session of sandbox.sessions) {
    console.log(`  session    ${session.name.padEnd(16)} ${session.cwd}`);
  }
  console.log(`\n  open       ${url}\n`);
}
