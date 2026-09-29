// Relay usage vs. Workers free-plan daily limits (reset 00:00 UTC).
// Auth: CLOUDFLARE_API_TOKEN, else wrangler's OAuth login.
// Usage: node scripts/usage.ts [--days N]
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

const API = "https://api.cloudflare.com/client/v4";
const GB = 1e9;

const FREE = {
  workerRequests: 100_000,
  workerCpuMs: 10,
  doRequests: 100_000,
  doDurationGbS: 13_000,
  rowsRead: 5_000_000,
  rowsWritten: 100_000,
  storageBytes: 5 * GB,
};

function wranglerToken(): string {
  const file = join(homedir(), ".config/.wrangler/config/default.toml");
  const match = readFileSync(file, "utf8").match(/^oauth_token\s*=\s*"([^"]+)"/m);
  if (!match?.[1]) throw new Error(`no oauth_token in ${file}; run: pnpm exec wrangler login`);
  return match[1];
}

// Wrangler refreshes its expired OAuth token as a side effect of any authed call.
function refreshWranglerLogin(): void {
  execFileSync("pnpm", ["exec", "wrangler", "whoami"], { cwd: join(import.meta.dirname, ".."), stdio: "ignore" });
}

async function api<T>(token: string, path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(API + path, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
  });
  if (res.status === 401 || res.status === 403) throw new AuthError(`${res.status} on ${path}`);
  const body = (await res.json()) as any;
  if (body.errors?.length) throw new Error(JSON.stringify(body.errors));
  return (body.result ?? body.data) as T;
}

class AuthError extends Error {}

async function withAuth<T>(run: (token: string) => Promise<T>): Promise<T> {
  const envToken = process.env.CLOUDFLARE_API_TOKEN;
  if (envToken) return run(envToken);
  try {
    return await run(wranglerToken());
  } catch (err) {
    if (!(err instanceof AuthError)) throw err;
    refreshWranglerLogin();
    return run(wranglerToken());
  }
}

async function accountId(token: string): Promise<string> {
  if (process.env.CLOUDFLARE_ACCOUNT_ID) return process.env.CLOUDFLARE_ACCOUNT_ID;
  const accounts = await api<{ id: string }[]>(token, "/accounts");
  if (accounts.length !== 1) throw new Error("set CLOUDFLARE_ACCOUNT_ID; token sees multiple accounts");
  return accounts[0]!.id;
}

type Day = {
  workerRequests: number;
  workerErrors: number;
  cpuP99Ms: number;
  doRequests: number;
  doDurationGbS: number;
  wsIn: number;
  wsOut: number;
  rowsRead: number;
  rowsWritten: number;
  storageBytes: number;
};

function emptyDay(): Day {
  return { workerRequests: 0, workerErrors: 0, cpuP99Ms: 0, doRequests: 0, doDurationGbS: 0, wsIn: 0, wsOut: 0, rowsRead: 0, rowsWritten: 0, storageBytes: 0 };
}

async function fetchDays(token: string, account: string, since: string, until: string): Promise<Map<string, Day>> {
  const filter = `{date_geq:"${since}", date_leq:"${until}"}`;
  const query = `{ viewer { accounts(filter:{accountTag:"${account}"}) {
    w: workersInvocationsAdaptive(limit:100, filter:${filter}) {
      sum { requests errors } quantiles { cpuTimeP99 } dimensions { date } }
    d: durableObjectsInvocationsAdaptiveGroups(limit:100, filter:${filter}) {
      sum { requests } dimensions { date } }
    p: durableObjectsPeriodicGroups(limit:100, filter:${filter}) {
      sum { duration inboundWebsocketMsgCount outboundWebsocketMsgCount rowsRead rowsWritten } dimensions { date } }
    s: durableObjectsStorageGroups(limit:100, filter:${filter}) {
      max { storedBytes } dimensions { date } }
  } } }`;
  const data = await api<any>(token, "/graphql", { method: "POST", body: JSON.stringify({ query }) });
  const acc = data.viewer.accounts[0] ?? {};
  const days = new Map<string, Day>();
  const day = (date: string) => days.get(date) ?? days.set(date, emptyDay()).get(date)!;

  for (const r of acc.w ?? []) {
    const d = day(r.dimensions.date);
    d.workerRequests += r.sum.requests;
    d.workerErrors += r.sum.errors;
    d.cpuP99Ms = Math.max(d.cpuP99Ms, r.quantiles.cpuTimeP99 / 1000);
  }
  for (const r of acc.d ?? []) day(r.dimensions.date).doRequests += r.sum.requests;
  for (const r of acc.p ?? []) {
    const d = day(r.dimensions.date);
    d.doDurationGbS += r.sum.duration;
    d.wsIn += r.sum.inboundWebsocketMsgCount;
    d.wsOut += r.sum.outboundWebsocketMsgCount;
    d.rowsRead += r.sum.rowsRead;
    d.rowsWritten += r.sum.rowsWritten;
  }
  for (const r of acc.s ?? []) {
    const d = day(r.dimensions.date);
    d.storageBytes = Math.max(d.storageBytes, r.max.storedBytes);
  }
  return days;
}

const num = (n: number) => n.toLocaleString("en-US", { maximumFractionDigits: 2 });
const bytes = (n: number) => (n >= 1e6 ? `${num(n / 1e6)} MB` : `${num(n / 1e3)} kB`);

function pct(used: number, limit: number): string {
  const p = (used / limit) * 100;
  const text = p < 0.1 && used > 0 ? "<0.1%" : `${p.toFixed(1)}%`;
  if (!process.stdout.isTTY) return text;
  const color = p >= 80 ? 31 : p >= 50 ? 33 : 32;
  return `\x1b[${color}m${text}\x1b[0m`;
}

function renderDay(date: string, d: Day): string {
  const rows = [
    ["Metric", "Used", "Free/day", "Share"],
    ["Worker requests", num(d.workerRequests), num(FREE.workerRequests), pct(d.workerRequests, FREE.workerRequests)],
    ["Worker errors", num(d.workerErrors), "-", "-"],
    ["Worker CPU p99", `${num(d.cpuP99Ms)} ms`, `${FREE.workerCpuMs} ms/req`, pct(d.cpuP99Ms, FREE.workerCpuMs)],
    ["DO requests (raw)", num(d.doRequests), num(FREE.doRequests), pct(d.doRequests, FREE.doRequests)],
    ["DO duration", `${num(d.doDurationGbS)} GB-s`, `${num(FREE.doDurationGbS)} GB-s`, pct(d.doDurationGbS, FREE.doDurationGbS)],
    ["WS msgs in / out", `${num(d.wsIn)} / ${num(d.wsOut)}`, "-", "-"],
    ["SQLite rows read", num(d.rowsRead), num(FREE.rowsRead), pct(d.rowsRead, FREE.rowsRead)],
    ["SQLite rows written", num(d.rowsWritten), num(FREE.rowsWritten), pct(d.rowsWritten, FREE.rowsWritten)],
    ["DO storage", bytes(d.storageBytes), "5 GB total", pct(d.storageBytes, FREE.storageBytes)],
  ];
  const visible = (s: string) => s.replace(/\x1b\[\d+m/g, "").length;
  const widths = rows[0]!.map((_, i) => Math.max(...rows.map((r) => visible(r[i]!))));
  const line = (r: string[]) => "| " + r.map((c, i) => c + " ".repeat(widths[i]! - visible(c))).join(" | ") + " |";
  const sep = "|" + widths.map((w) => "-".repeat(w + 2)).join("|") + "|";
  return [`${date} (UTC)`, line(rows[0]!), sep, ...rows.slice(1).map(line)].join("\n");
}

function parseDays(argv: string[]): number {
  const i = argv.indexOf("--days");
  if (i === -1) return 1;
  const n = Number(argv[i + 1]);
  if (!Number.isInteger(n) || n < 1 || n > 30) throw new Error("--days must be 1..30");
  return n;
}

const isoDate = (d: Date) => d.toISOString().slice(0, 10);

async function main(): Promise<void> {
  const days = parseDays(process.argv.slice(2));
  const until = new Date();
  const since = new Date(until.getTime() - (days - 1) * 86_400_000);

  const byDate = await withAuth(async (token) => fetchDays(token, await accountId(token), isoDate(since), isoDate(until)));

  const dates = [...byDate.keys()].sort();
  if (dates.length === 0) {
    console.log("No usage recorded in range.");
    return;
  }
  console.log(dates.map((date) => renderDay(date, byDate.get(date)!)).join("\n\n"));
  console.log("\nAccount-wide. Incoming WS messages bill at 20:1, so billed DO requests are likely lower than raw.");
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
