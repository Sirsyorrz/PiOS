import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { WebSocket } from "ws";

/**
 * The smallest Chrome DevTools client that can prove a UI change works.
 *
 * Deliberately not a browser-automation framework: an agent needs to look at
 * a phone-sized viewport, read some text back, and tap a thing. Anything more
 * is a dependency that has to be installed before the first screenshot.
 */

const CHROME_CANDIDATES = [
  "chromium",
  "google-chrome-stable",
  "google-chrome",
  "brave",
  "chrome",
];

/** iPhone 14-ish. The app is a phone client; desktop pixels prove nothing. */
export const PHONE_VIEWPORT = { width: 390, height: 844, scale: 2 };

export interface BrowserOptions {
  headless?: boolean;
  viewport?: { width: number; height: number; scale?: number };
}

export class Browser {
  private readonly proc: ChildProcess;
  private readonly socket: WebSocket;
  private readonly profileDir: string;
  private seq = 0;
  private readonly pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();

  private constructor(proc: ChildProcess, socket: WebSocket, profileDir: string) {
    this.proc = proc;
    this.socket = socket;
    this.profileDir = profileDir;
    socket.on("message", (data) => {
      const message = JSON.parse(String(data)) as { id?: number; result?: unknown; error?: { message: string } };
      if (message.id === undefined) return;
      const waiter = this.pending.get(message.id);
      if (!waiter) return;
      this.pending.delete(message.id);
      if (message.error) waiter.reject(new Error(message.error.message));
      else waiter.resolve(message.result);
    });
  }

  static async launch(options: BrowserOptions = {}): Promise<Browser> {
    const binary = chromeBinary();
    const profileDir = mkdtempSync(join(tmpdir(), "pios-chrome-"));
    const port = 9333 + Math.floor(Math.random() * 500);
    const viewport = options.viewport ?? PHONE_VIEWPORT;
    const proc = spawn(
      binary,
      [
        `--remote-debugging-port=${port}`,
        `--user-data-dir=${profileDir}`,
        ...(options.headless === false ? [] : ["--headless=new"]),
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-gpu",
        `--window-size=${viewport.width},${viewport.height}`,
        "about:blank",
      ],
      { stdio: "ignore" },
    );

    const target = await waitForTarget(port);
    const socket = new WebSocket(target);
    await new Promise((resolve, reject) => {
      socket.once("open", resolve);
      socket.once("error", reject);
    });

    const browser = new Browser(proc, socket, profileDir);
    await browser.send("Page.enable");
    await browser.send("Runtime.enable");
    await browser.send("Emulation.setDeviceMetricsOverride", {
      width: viewport.width,
      height: viewport.height,
      deviceScaleFactor: viewport.scale ?? 2,
      mobile: true,
    });
    return browser;
  }

  send(method: string, params: Record<string, unknown> = {}): Promise<any> {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (!this.pending.delete(id)) return;
        reject(new Error(`CDP timeout: ${method}`));
      }, 30_000);
    });
  }

  async goto(url: string): Promise<void> {
    await this.send("Page.navigate", { url });
    // `Page.loadEventFired` says the document loaded, not that React drew;
    // the callers that care wait on a selector instead.
    await this.sleep(400);
  }

  /** Evaluates in the page and returns the JSON value. */
  async eval<T = unknown>(expression: string): Promise<T> {
    const result = await this.send("Runtime.evaluate", {
      expression: `(async () => { return (${expression}); })()`,
      awaitPromise: true,
      returnByValue: true,
    });
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description ?? "eval failed");
    }
    return result.result?.value as T;
  }

  /** Resolves once a selector matches, so screenshots are not of a blank app. */
  async waitFor(selector: string, timeoutMs = 10_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const found = await this.eval<boolean>(`!!document.querySelector(${JSON.stringify(selector)})`);
      if (found) return;
      await this.sleep(100);
    }
    throw new Error(`timed out waiting for ${selector}`);
  }

  /**
   * Taps the innermost clickable element whose text contains `text`.
   *
   * Innermost matters: a row's `li` wrapper also contains the text, and
   * clicking it dispatches an event no handler is listening for.
   */
  async tapText(text: string): Promise<boolean> {
    return this.eval<boolean>(`(() => {
      const needle = ${JSON.stringify(text)};
      const nodes = [...document.querySelectorAll('button, a, [role="button"], .list-row')];
      const matches = nodes.filter((n) => (n.textContent || '').includes(needle));
      const hit = matches.findLast((n) => !matches.some((o) => o !== n && n.contains(o)));
      if (!hit) return false;
      hit.click();
      return true;
    })()`);
  }

  async tap(selector: string): Promise<boolean> {
    return this.eval<boolean>(
      `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return false; el.click(); return true; })()`,
    );
  }

  /** Types into an input the way React listens for it. */
  async type(selector: string, value: string): Promise<boolean> {
    return this.eval<boolean>(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return false;
      const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement : HTMLInputElement;
      const setter = Object.getOwnPropertyDescriptor(proto.prototype, 'value').set;
      setter.call(el, ${JSON.stringify(value)});
      el.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()`);
  }

  async text(selector = "body"): Promise<string> {
    return this.eval<string>(
      `(document.querySelector(${JSON.stringify(selector)})?.innerText ?? '')`,
    );
  }

  async screenshot(path: string): Promise<string> {
    const { data } = await this.send("Page.captureScreenshot", { format: "png" });
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, Buffer.from(data, "base64"));
    return path;
  }

  sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async close(): Promise<void> {
    this.socket.close();
    this.proc.kill();
    // Chrome keeps writing its profile for a moment after the signal, so a
    // plain remove loses a race and throws ENOTEMPTY over a passing run.
    await new Promise<void>((resolve) => {
      if (this.proc.exitCode !== null || this.proc.signalCode !== null) resolve();
      else this.proc.once("exit", () => resolve());
      setTimeout(resolve, 2_000);
    });
    rmSync(this.profileDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

function chromeBinary(): string {
  const explicit = process.env.PIOS_CHROME;
  if (explicit) return explicit;
  for (const candidate of CHROME_CANDIDATES) {
    for (const dir of (process.env.PATH ?? "").split(":")) {
      if (dir && existsSync(join(dir, candidate))) return join(dir, candidate);
    }
  }
  throw new Error(
    `no Chrome found. Install chromium or set PIOS_CHROME to a binary.`,
  );
}

async function waitForTarget(port: number, timeoutMs = 15_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`);
      const targets = (await response.json()) as { type: string; webSocketDebuggerUrl?: string }[];
      const page = targets.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
      if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
    } catch {
      // Chrome has not opened the port yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error("Chrome did not expose a debugging target");
}
