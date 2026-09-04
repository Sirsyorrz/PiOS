import { execFile } from "node:child_process";

/**
 * Claude plan usage, read from the `cc-usage` CLI.
 *
 * Optional by design: the daemon has no Claude credentials of its own, and a
 * machine without the CLI simply reports usage as unavailable rather than
 * failing the settings page.
 */

export interface UsageWindow {
  key: string;
  label: string;
  percent: number;
  resetsAt: string | null;
}

export interface UsageReport {
  windows: UsageWindow[];
  /** Extra-usage credits, in minor units of `currency`, when enabled. */
  spend: { used: number; limit: number | null; currency: string; exponent: number } | null;
  fetchedAt: number;
}

const LABELS: Record<string, string> = {
  session: "Current session (5h)",
  weekly_all: "This week, all models",
  weekly_opus: "This week, Opus",
  weekly_sonnet: "This week, Sonnet",
};

const TTL_MS = 60_000;
const TIMEOUT_MS = 10_000;

let cached: UsageReport | null = null;
let inflight: Promise<UsageReport | null> | null = null;

/** Cached because the CLI hits Anthropic's API and every device polls it. */
export async function claudeUsage(now = Date.now()): Promise<UsageReport | null> {
  if (cached && now - cached.fetchedAt < TTL_MS) return cached;
  inflight ??= run()
    .then((report) => {
      if (report) cached = report;
      return report;
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

async function run(): Promise<UsageReport | null> {
  let stdout: string;
  try {
    stdout = await exec();
  } catch {
    // No CLI, no credentials, or no network: all mean "cannot say".
    return null;
  }
  try {
    return parseUsage(JSON.parse(stdout));
  } catch {
    return null;
  }
}

function exec(): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "cc-usage",
      ["--raw"],
      { timeout: TIMEOUT_MS, maxBuffer: 1024 * 1024 },
      (error, stdout) => (error ? reject(error) : resolve(stdout)),
    );
  });
}

export function parseUsage(raw: unknown): UsageReport | null {
  if (!raw || typeof raw !== "object") return null;
  const body = raw as { limits?: unknown; spend?: unknown };
  const limits = Array.isArray(body.limits) ? body.limits : [];

  const windows: UsageWindow[] = [];
  for (const entry of limits) {
    const limit = entry as { kind?: unknown; percent?: unknown; resets_at?: unknown };
    if (typeof limit.kind !== "string" || typeof limit.percent !== "number") continue;
    windows.push({
      key: limit.kind,
      label: LABELS[limit.kind] ?? limit.kind.replace(/_/g, " "),
      percent: Math.max(0, Math.min(100, Math.round(limit.percent))),
      resetsAt: typeof limit.resets_at === "string" ? limit.resets_at : null,
    });
  }

  return { windows, spend: parseSpend(body.spend), fetchedAt: Date.now() };
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
