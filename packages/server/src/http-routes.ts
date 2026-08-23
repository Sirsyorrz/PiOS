import { createReadStream, statSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { extname, join } from "node:path";
import type { SessionRegistry } from "@pios/pi-host";
import { WIRE_VERSION } from "@pios/protocol";
import { AuthStore, bearerToken } from "./auth.ts";
import { containedPath } from "./paths.ts";
import { SERVER_VERSION, type ServerConfig } from "./config.ts";

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
};

export interface RouteContext {
  config: ServerConfig;
  auth: AuthStore;
  registry: SessionRegistry;
}

export async function handleRequest(
  ctx: RouteContext,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost");

  try {
    // Unauthenticated by necessity: this is how a device gets its first token.
    if (req.method === "POST" && url.pathname === "/pair") return await pair(ctx, req, res);
    // Deliberately says nothing about sessions, paths, or devices.
    if (req.method === "GET" && url.pathname === "/health") {
      return json(res, 200, { ok: true, serverVersion: SERVER_VERSION, wireVersion: WIRE_VERSION });
    }

    const device = ctx.auth.verify(bearerToken(req.headers.authorization));
    if (!device) return json(res, 401, { error: "unauthorized" });

    if (req.method === "GET" && url.pathname === "/sessions") {
      return json(res, 200, { sessions: ctx.registry.list() });
    }
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
