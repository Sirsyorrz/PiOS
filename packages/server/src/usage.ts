import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import lockfile from "proper-lockfile";
import type { UsageReport, UsageWindow } from "@pios/protocol";

/**
 * Claude plan usage, read with the Anthropic OAuth login pi already holds.
 *
 * Optional by design: without a subscription login in pi's `auth.json` the
 * settings page shows usage as unavailable rather than failing.
 */

const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const TOKEN_URL = "https://platform.claude.com/v1/oauth/token";
// Claude Code's public OAuth client, the one pi logs in with.
const CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const PROVIDER = "anthropic";

// The pi status bar shares this cache file, so every reader together makes
// one request per TTL; the endpoint rate limits hard.
const TTL_MS = 5 * 60_000;
const RATE_LIMIT_BACKOFF_MS = [5 * 60_000, 10 * 60_000, 30 * 60_000];
const ERROR_BACKOFF_MS = 60_000;
const TIMEOUT_MS = 10_000;
// Matches pi, which treats tokens as expired five minutes early.
const EXPIRY_MARGIN_MS = 5 * 60_000;

const LABELS: Record<string, string> = {
  session: "Current session (5h)",
  weekly_all: "This week, all models",
  weekly_opus: "This week, Opus",
  weekly_sonnet: "This week, Sonnet",
};

/** Older responses carry windows as top-level keys instead of `limits[]`. */
const LEGACY_WINDOWS: Record<string, string> = {
  five_hour: "session",
  seven_day: "weekly_all",
  seven_day_opus: "weekly_opus",
  seven_day_sonnet: "weekly_sonnet",
};

interface OAuthCredential {
  type: "oauth";
  access: string;
  refresh: string;
  expires: number;
}

/** The pi status bar's format: the raw API response plus a shared backoff. */
interface UsageCache {
  timestamp: number;
  data: unknown;
  rate_limited_until?: number;
  rate_limit_count?: number;
}

class HttpError extends Error {
  readonly status: number;
  readonly retryAfterMs: number | null;

  constructor(status: number, retryAfterMs: number | null) {
    super(`HTTP ${status}`);
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}

export interface ClaudeUsageOptions {
  /** pi's `auth.json`; refreshed tokens are written back for pi to use. */
  authPath: string;
  /** Shared with other readers of the same endpoint, including their backoff. */
  cachePath: string;
  fetch?: typeof fetch;
  now?: () => number;
}

export class ClaudeUsage {
  private readonly authPath: string;
  private readonly cachePath: string;
  private readonly fetch: typeof fetch;
  private readonly now: () => number;
  /** Network and auth failures back off here only; 429s go in the shared file. */
  private retryAt = 0;
  private inflight: Promise<UsageReport | null> | null = null;

  constructor(options: ClaudeUsageOptions) {
    this.authPath = options.authPath;
    this.cachePath = options.cachePath;
    this.fetch = options.fetch ?? fetch;
    this.now = options.now ?? Date.now;
  }

  /** The latest report; a stale one beats none while the endpoint pushes back. */
  async get(): Promise<UsageReport | null> {
    this.inflight ??= this.load().finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  private async load(): Promise<UsageReport | null> {
    const cache = await this.readCache();
    const now = this.now();
    const fresh = cache !== null && now - cache.timestamp < TTL_MS;
    const limited = (cache?.rate_limited_until ?? 0) > now;
    if (fresh || limited || now < this.retryAt) return reportFrom(cache);

    try {
      const data = await this.request();
      if (data === null) return reportFrom(cache);
      await this.writeCache({ timestamp: now, data });
      return reportFrom({ timestamp: now, data });
    } catch (error) {
      if (error instanceof HttpError && error.status === 429) {
        await this.backOff(cache, error.retryAfterMs);
      } else {
        this.retryAt = this.now() + ERROR_BACKOFF_MS;
      }
      return reportFrom(cache);
    }
  }

  /** Escalates with each consecutive 429, so every reader waits longer. */
  private async backOff(cache: UsageCache | null, retryAfterMs: number | null): Promise<void> {
    const count = (cache?.rate_limit_count ?? 0) + 1;
    const ladder = RATE_LIMIT_BACKOFF_MS[Math.min(count, RATE_LIMIT_BACKOFF_MS.length) - 1]!;
    await this.writeCache({
      timestamp: cache?.timestamp ?? 0,
      data: cache?.data ?? null,
      rate_limited_until: this.now() + Math.max(ladder, retryAfterMs ?? 0),
      rate_limit_count: count,
    });
  }

  private async readCache(): Promise<UsageCache | null> {
    try {
      const parsed = JSON.parse(await readFile(this.cachePath, "utf8")) as UsageCache;
      return typeof parsed?.timestamp === "number" ? parsed : null;
    } catch {
      return null;
    }
  }

  private async writeCache(cache: UsageCache): Promise<void> {
    // Renamed into place so a concurrent reader never parses half a file.
    const temp = `${this.cachePath}.${process.pid}.tmp`;
    try {
      await mkdir(dirname(this.cachePath), { recursive: true });
      await writeFile(temp, JSON.stringify(cache));
      await rename(temp, this.cachePath);
    } catch {
      // A cache that cannot be written only costs an extra request later.
    }
  }

  private async request(): Promise<unknown> {
    let credential = await this.credential();
    if (!credential) return null;
    try {
      return await this.fetchUsage(credential.access);
    } catch (error) {
      // pi may have rotated the token since it was read, or it was revoked.
      if (!(error instanceof HttpError) || error.status !== 401) throw error;
      credential = await this.refresh(credential.access);
      if (!credential) return null;
      return await this.fetchUsage(credential.access);
    }
  }

  private async credential(): Promise<OAuthCredential | null> {
    const credential = readCredential(await this.readAuth());
    if (!credential) return null;
    if (credential.expires > this.now()) return credential;
    return await this.refresh(credential.access);
  }

  /**
   * Refreshes under pi's own lock on `auth.json`. Refresh tokens rotate, so
   * two holders refreshing at once would leave one with a dead token; the
   * lock serialises with pi, and the re-read skips the refresh when pi got
   * there first.
   */
  private async refresh(staleAccess: string): Promise<OAuthCredential | null> {
    const release = await lockfile.lock(this.authPath, {
      realpath: false,
      stale: 30_000,
      retries: { retries: 20, minTimeout: 50, maxTimeout: 1_000 },
    });
    try {
      const auth = await this.readAuth();
      const current = readCredential(auth);
      if (!current) return null;
      if (current.access !== staleAccess && current.expires > this.now()) return current;

      const next = await this.exchange(current.refresh);
      const merged = { ...auth, [PROVIDER]: { ...current, ...next } };
      await writeFile(this.authPath, JSON.stringify(merged, null, 2), { mode: 0o600 });
      return merged[PROVIDER];
    } finally {
      await release();
    }
  }

  private async exchange(refreshToken: string): Promise<OAuthCredential> {
    const response = await this.fetch(TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({
        grant_type: "refresh_token",
        client_id: CLIENT_ID,
        refresh_token: refreshToken,
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!response.ok) throw httpError(response);
    const body = (await response.json()) as {
      access_token?: unknown;
      refresh_token?: unknown;
      expires_in?: unknown;
    };
    if (typeof body.access_token !== "string" || typeof body.expires_in !== "number") {
      throw new Error("malformed token response");
    }
    return {
      type: "oauth",
      access: body.access_token,
      refresh: typeof body.refresh_token === "string" ? body.refresh_token : refreshToken,
      expires: this.now() + body.expires_in * 1000 - EXPIRY_MARGIN_MS,
    };
  }

  private async fetchUsage(access: string): Promise<unknown> {
    const response = await this.fetch(USAGE_URL, {
      headers: {
        authorization: `Bearer ${access}`,
        "anthropic-beta": "oauth-2025-04-20",
      },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!response.ok) throw httpError(response);
    return await response.json();
  }

  private async readAuth(): Promise<Record<string, unknown>> {
    try {
      const parsed: unknown = JSON.parse(await readFile(this.authPath, "utf8"));
      return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  }
}

function readCredential(auth: Record<string, unknown>): OAuthCredential | null {
  const value = auth[PROVIDER] as Partial<OAuthCredential> | undefined;
  if (value?.type !== "oauth") return null;
  if (typeof value.access !== "string" || typeof value.refresh !== "string") return null;
  return { ...value, expires: typeof value.expires === "number" ? value.expires : 0 } as OAuthCredential;
}

function httpError(response: Response): HttpError {
  const seconds = Number(response.headers.get("retry-after"));
  return new HttpError(response.status, Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : null);
}

function reportFrom(cache: UsageCache | null): UsageReport | null {
  const report = parseUsage(cache?.data, cache?.timestamp);
  return report && (report.windows.length > 0 || report.spend) ? report : null;
}

export function parseUsage(raw: unknown, fetchedAt = Date.now()): UsageReport | null {
  if (!raw || typeof raw !== "object") return null;
  const body = raw as Record<string, unknown>;
  const windows = Array.isArray(body.limits) ? limitWindows(body.limits) : legacyWindows(body);
  return { windows, spend: parseSpend(body.spend), fetchedAt };
}

function limitWindows(limits: unknown[]): UsageWindow[] {
  const windows: UsageWindow[] = [];
  for (const entry of limits) {
    const limit = entry as {
      kind?: unknown;
      percent?: unknown;
      resets_at?: unknown;
      scope?: { model?: { display_name?: unknown } | null } | null;
    };
    if (typeof limit.kind !== "string" || typeof limit.percent !== "number") continue;
    // Per-model weekly limits share one kind; the model name tells them apart.
    const model = limit.scope?.model?.display_name;
    const scoped = typeof model === "string" && model.length > 0;
    windows.push(
      usageWindow(
        scoped ? `${limit.kind}:${model}` : limit.kind,
        scoped ? `This week, ${model}` : undefined,
        limit.percent,
        limit.resets_at,
      ),
    );
  }
  return windows;
}

function legacyWindows(body: Record<string, unknown>): UsageWindow[] {
  const windows: UsageWindow[] = [];
  for (const [field, key] of Object.entries(LEGACY_WINDOWS)) {
    const window = body[field] as { utilization?: unknown; resets_at?: unknown } | null | undefined;
    if (typeof window?.utilization !== "number") continue;
    windows.push(usageWindow(key, undefined, window.utilization, window.resets_at));
  }
  return windows;
}

function usageWindow(
  key: string,
  label: string | undefined,
  percent: number,
  resetsAt: unknown,
): UsageWindow {
  return {
    key,
    label: label ?? LABELS[key] ?? key.replace(/_/g, " "),
    percent: Math.max(0, Math.min(100, Math.round(percent))),
    resetsAt: typeof resetsAt === "string" ? resetsAt : null,
  };
}

function parseSpend(raw: unknown): UsageReport["spend"] {
  if (!raw || typeof raw !== "object") return null;
  const spend = raw as {
    enabled?: unknown;
    used?: { amount_minor?: unknown; currency?: unknown; exponent?: unknown };
    limit?: { amount_minor?: unknown };
  };
  if (spend.enabled !== true) return null;
  const used = spend.used;
  if (typeof used?.amount_minor !== "number") return null;
  return {
    used: used.amount_minor,
    limit: typeof spend.limit?.amount_minor === "number" ? spend.limit.amount_minor : null,
    currency: typeof used.currency === "string" ? used.currency : "USD",
    exponent: typeof used.exponent === "number" ? used.exponent : 2,
  };
}
