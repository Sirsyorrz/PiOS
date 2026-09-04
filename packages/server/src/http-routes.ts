import { createReadStream, statSync } from "node:fs";
import { mkdir, readdir, stat, writeFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { homedir } from "node:os";
import { basename, dirname, extname, join, sep } from "node:path";
import { sessionDirName, type SessionRegistry } from "@pios/pi-host";
import { WIRE_VERSION } from "@pios/protocol";
import { AuthStore, bearerToken } from "./auth.ts";
import { containedPath } from "./paths.ts";
import type { PushStore } from "./push.ts";
import { SERVER_VERSION, type ServerConfig } from "./config.ts";
import { claudeUsage } from "./usage.ts";

const CONTENT_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".pdf": "application/pdf",
  ".json": "application/json",
  ".md": "text/markdown; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".webmanifest": "application/manifest+json",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

/** Everything the daemon answers itself; the rest may be the PWA. */
const API_PATHS = new Set([
  // A GET that never upgraded must not be answered with the app shell: a
  // client would parse HTML as a socket failure it cannot explain.
  "/ws",
  "/pair",
  "/health",
  "/sessions",
  "/dirs",
  "/file",
  "/upload",
  "/push/key",
  "/push/subscribe",
  "/push/unsubscribe",
  "/usage",
]);

export interface RouteContext {
  config: ServerConfig;
  auth: AuthStore;
  registry: SessionRegistry;
  push: PushStore;
}

export async function handleRequest(
  ctx: RouteContext,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost");
  cors(req, res);

  try {
    // The preflight carries no credentials, so it cannot be authenticated and
    // must be answered before the auth check.
    if (req.method === "OPTIONS") {
      res.writeHead(204).end();
      return;
    }
    // Unauthenticated by necessity: this is how a device gets its first token.
    if (req.method === "POST" && url.pathname === "/pair") return await pair(ctx, req, res);
    // Deliberately says nothing about sessions, paths, or devices.
    if (req.method === "GET" && url.pathname === "/health") {
      return json(res, 200, { ok: true, serverVersion: SERVER_VERSION, wireVersion: WIRE_VERSION });
    }

    // The app shell itself is public: a browser cannot put a bearer token on
    // the document request that bootstraps it, and the bundle holds no
    // secrets. Everything it then asks for is authenticated.
    if (req.method === "GET" && !API_PATHS.has(url.pathname) && ctx.config.webDir) {
      return serveApp(ctx.config.webDir, url, res);
    }

    const device = ctx.auth.verify(bearerToken(req.headers.authorization));
    if (!device) return json(res, 401, { error: "unauthorized" });

    if (req.method === "GET" && url.pathname === "/sessions") {
      return json(res, 200, { sessions: ctx.registry.list() });
    }
    // The VAPID public key is a public value by design: it identifies the
    // sender to the push service and authorises nothing on its own.
    if (req.method === "GET" && url.pathname === "/push/key") {
      return json(res, 200, { publicKey: ctx.push.publicKey });
    }
    if (req.method === "POST" && url.pathname === "/push/subscribe") {
      return await pushSubscribe(ctx, device.id, req, res);
    }
    if (req.method === "POST" && url.pathname === "/push/unsubscribe") {
      const body = await readJson(req, 8 * 1024);
      const endpoint = typeof body?.endpoint === "string" ? body.endpoint : undefined;
      if (!endpoint) return json(res, 400, { error: "bad_request" });
      return json(res, 200, { removed: ctx.push.unsubscribe(endpoint) });
    }
    if (req.method === "GET" && url.pathname === "/usage") {
      const usage = await claudeUsage();
      return json(res, 200, { usage });
    }
    if (req.method === "GET" && url.pathname === "/dirs") return await listDirs(ctx, url, res);
    if (req.method === "GET" && url.pathname === "/file") return serveFile(ctx, url, res);
    if (req.method === "POST" && url.pathname === "/upload") {
      return await upload(ctx, url, req, res);
    }
    return json(res, 404, { error: "not_found" });
  } catch (error) {
    console.error("[pios] request failed", error);
    json(res, 500, { error: "internal" });
  }
}

/**
 * Static file serving for the built PWA.
 *
 * Unknown paths fall back to `index.html` so a deep link like
 * `/?session=...` from a notification survives a cold launch. Content-hashed
 * assets are immutable; the document and the service worker never are, or a
 * new build would never reach an installed app.
 */
function serveApp(webDir: string, url: URL, res: ServerResponse): void {
  const requested = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
  const candidate = containedPath(webDir, requested);
  const path =
    candidate && statSync(candidate, { throwIfNoEntry: false })?.isFile()
      ? candidate
      : join(webDir, "index.html");

  let stat;
  try {
    stat = statSync(path);
  } catch {
    return json(res, 404, { error: "not_found" });
  }

  const immutable = path.includes(`${sep}assets${sep}`);
  res.writeHead(200, {
    "content-type": CONTENT_TYPES[extname(path).toLowerCase()] ?? "application/octet-stream",
    "content-length": stat.size,
    "cache-control": immutable ? "public, max-age=31536000, immutable" : "no-cache",
  });
  createReadStream(path).pipe(res);
}

async function pair(ctx: RouteContext, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readJson(req, 8 * 1024);
  const token = typeof body?.pairingToken === "string" ? body.pairingToken : undefined;
  const label = typeof body?.label === "string" ? body.label.slice(0, 64) : "unnamed device";
  if (!token) return json(res, 400, { error: "bad_request" });

  const result = ctx.auth.redeemPairing(token, label);
  // One response for a bad token and an expired one: an attacker learns
  // nothing about which pairing codes ever existed.
  if (!result) return json(res, 401, { error: "invalid_pairing_token" });

  json(res, 200, {
    deviceToken: result.deviceToken,
    deviceId: result.device.id,
    serverVersion: SERVER_VERSION,
    wireVersion: WIRE_VERSION,
  });
}

/**
 * Registers a Web Push subscription against the calling device.
 *
 * Only the endpoint and the two client keys are stored: the daemon is the
 * sender, so it needs nothing else, and holding less means a leaked file wakes
 * fewer phones.
 */
async function pushSubscribe(
  ctx: RouteContext,
  deviceId: string,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const body = await readJson(req, 8 * 1024);
  const endpoint = typeof body?.endpoint === "string" ? body.endpoint : undefined;
  const keys = body?.keys as { p256dh?: unknown; auth?: unknown } | undefined;
  const p256dh = typeof keys?.p256dh === "string" ? keys.p256dh : undefined;
  const auth = typeof keys?.auth === "string" ? keys.auth : undefined;
  if (!endpoint || !p256dh || !auth || !/^https:\/\//.test(endpoint)) {
    return json(res, 400, { error: "bad_request" });
  }

  const record = ctx.push.subscribe(deviceId, { endpoint, keys: { p256dh, auth } });
  json(res, 200, { id: record.id });
}

/**
 * Directory listing for the session-creation picker.
 *
 * Rooted at the home directory: the daemon already runs arbitrary code as the
 * user, but browsing the whole filesystem from a phone is a bigger surface
 * than the feature needs, and `/` is never where a project lives.
 *
 * Ordered by the most recent pi session at or below each entry, then by name:
 * the directory someone wants next is nearly always one they worked in.
 */
async function listDirs(ctx: RouteContext, url: URL, res: ServerResponse): Promise<void> {
  const root = homedir();
  const requested = url.searchParams.get("path") ?? root;
  const path = containedPath(root, requested);
  if (!path) return json(res, 404, { error: "not_found" });

  let dirents;
  try {
    dirents = await readdir(path, { withFileTypes: true });
  } catch {
    return json(res, 404, { error: "not_found" });
  }

  const recency = await sessionRecency(ctx.config.sessionDir);
  const entries = dirents
    .filter((d) => d.isDirectory() && !d.name.startsWith("."))
    .map((d) => {
      const child = join(path, d.name);
      return { name: d.name, path: child, lastSessionAt: lastSessionAt(recency, child) };
    })
    .sort((a, b) => (b.lastSessionAt ?? 0) - (a.lastSessionAt ?? 0) || a.name.localeCompare(b.name));

  json(res, 200, {
    root,
    path,
    name: basename(path) || path,
    parent: path === root ? null : dirname(path),
    entries,
  });
}

/** Session directory name -> last write, for every project pi knows about. */
async function sessionRecency(sessionDir: string): Promise<Map<string, number>> {
  const found = new Map<string, number>();
  let dirents;
  try {
    dirents = await readdir(sessionDir, { withFileTypes: true });
  } catch {
    return found;
  }
  await Promise.all(
    dirents
      .filter((d) => d.isDirectory())
      .map(async (d) => {
        try {
          found.set(d.name, (await stat(join(sessionDir, d.name))).mtimeMs);
        } catch {
          // A directory that vanished mid-listing simply has no recency.
        }
      }),
  );
  return found;
}

/**
 * Newest session in the subtree, so a parent like `~/Code` sorts by the work
 * inside it. pi's name encoding is lossy, so a sibling whose name starts with
 * this one plus `-` can bleed in; that only ever perturbs the ordering.
 */
function lastSessionAt(recency: Map<string, number>, cwd: string): number | null {
  const key = sessionDirName(cwd);
  const subtree = key.slice(0, -2) + "-";
  let newest = 0;
  for (const [name, mtime] of recency) {
    if (name === key || name.startsWith(subtree)) newest = Math.max(newest, mtime);
  }
  return newest || null;
}

function serveFile(ctx: RouteContext, url: URL, res: ServerResponse): void {
  const sessionId = url.searchParams.get("session");
  const requested = url.searchParams.get("path");
  if (!sessionId || !requested) return json(res, 400, { error: "bad_request" });

  const session = ctx.registry.get(sessionId);
  if (!session) return json(res, 404, { error: "unknown_session" });

  const path = containedPath(session.info.cwd, requested);
  // A path outside the session cwd is reported as missing, not as forbidden:
  // the difference would confirm what exists on the machine.
  if (!path) return json(res, 404, { error: "not_found" });

  let stat;
  try {
    stat = statSync(path);
  } catch {
    return json(res, 404, { error: "not_found" });
  }
  if (!stat.isFile()) return json(res, 404, { error: "not_found" });

  res.writeHead(200, {
    "content-type": CONTENT_TYPES[extname(path).toLowerCase()] ?? "application/octet-stream",
    "content-length": stat.size,
    // The agent rewrites files under the same path constantly.
    "cache-control": "no-store",
  });
  createReadStream(path).pipe(res);
}

async function upload(
  ctx: RouteContext,
  url: URL,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const sessionId = url.searchParams.get("session");
  const name = url.searchParams.get("name") ?? "upload.bin";
  if (!sessionId) return json(res, 400, { error: "bad_request" });

  const session = ctx.registry.get(sessionId);
  if (!session) return json(res, 404, { error: "unknown_session" });

  const dir = join(session.info.cwd, ".pios-uploads");
  const safeName = name.replace(/[^\w.-]/g, "_").slice(0, 96);
  const target = containedPath(dir, safeName);
  if (!target) return json(res, 400, { error: "bad_request" });

  const body = await readBody(req, ctx.config.maxUploadBytes);
  if (!body) return json(res, 413, { error: "too_large" });

  await mkdir(dir, { recursive: true });
  await writeFile(target, body);
  json(res, 200, { path: target, bytes: body.length });
}

/**
 * Cross-origin access for the PWA.
 *
 * The app is served from a different port (a dev server now, a static host
 * later), so every call here is cross-origin. Authorisation is a bearer token
 * the browser never sends on its own, and credentials are never allowed, so a
 * hostile page gains nothing from being able to make the request.
 */
function cors(req: IncomingMessage, res: ServerResponse): void {
  const origin = req.headers.origin;
  if (!origin) return;
  res.setHeader("access-control-allow-origin", origin);
  res.setHeader("vary", "origin");
  res.setHeader("access-control-allow-methods", "GET, POST, OPTIONS");
  res.setHeader("access-control-allow-headers", "authorization, content-type");
  res.setHeader("access-control-max-age", "600");
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

async function readBody(req: IncomingMessage, limit: number): Promise<Buffer | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    // Stop reading rather than buffering the whole oversized body first.
    if (size > limit) {
      req.destroy();
      return null;
    }
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

async function readJson(
  req: IncomingMessage,
  limit: number,
): Promise<Record<string, unknown> | null> {
  const body = await readBody(req, limit);
  if (!body) return null;
  try {
    return JSON.parse(body.toString("utf8"));
  } catch {
    return null;
  }
}
