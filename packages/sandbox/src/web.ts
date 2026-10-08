import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { Sandbox } from "./sandbox.ts";

const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));

/**
 * The PWA's dev server, proxying the API to a sandbox daemon.
 *
 * The dev server rather than a build, so what is driven is the source on disk
 * right now. One origin for the app and the API, as the deployed daemon has.
 */
export function startWeb(target: string, port: number, stdio: "inherit" | "ignore"): ChildProcess {
  return spawn("pnpm", ["-F", "@pios/web", "dev", "--port", String(port), "--strictPort"], {
    cwd: REPO_ROOT,
    stdio,
    // A machine-wide NODE_ENV=production would hand the dev server React's
    // production build and no HMR.
    env: { ...process.env, NODE_ENV: "development", PIOS_SANDBOX_TARGET: target },
  });
}

export async function waitForWeb(port: number, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await fetch(`http://127.0.0.1:${port}/`);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
  }
  throw new Error("dev server did not start");
}

/** The one URL that pairs the app and opens it, with no clicks in between. */
export function appUrl(sandbox: Sandbox, port: number): string {
  return `http://localhost:${port}/?sandbox=1&token=${sandbox.deviceToken}`;
}
