import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ClaudeUsage, parseUsage } from "../src/usage.ts";

const sample = {
  limits: [
    { kind: "session", percent: 11.4, resets_at: "2026-09-04T03:09:59Z" },
    { kind: "weekly_all", percent: 12, resets_at: null },
    { kind: "broken" },
  ],
  spend: {
    enabled: true,
    used: { amount_minor: 670, currency: "USD", exponent: 2 },
    limit: null,
  },
};

test("a usage response becomes windows a phone can render", () => {
  const report = parseUsage(sample);
  assert.deepEqual(
    report?.windows.map((w) => [w.key, w.percent, w.resetsAt]),
    [
      ["session", 11, "2026-09-04T03:09:59Z"],
      ["weekly_all", 12, null],
    ],
  );
  assert.equal(report?.windows[0]?.label, "Current session (5h)");
  assert.deepEqual(report?.spend, { used: 670, limit: null, currency: "USD", exponent: 2 });
});

test("per-model weekly limits stay apart and are named by model", () => {
  const report = parseUsage({
    limits: [
      { kind: "weekly_scoped", percent: 40, scope: { model: { display_name: "Opus" } } },
      { kind: "weekly_scoped", percent: 5, scope: { model: { display_name: "Fable" } } },
    ],
  });
  assert.deepEqual(
    report?.windows.map((w) => [w.key, w.label]),
    [
      ["weekly_scoped:Opus", "This week, Opus"],
      ["weekly_scoped:Fable", "This week, Fable"],
    ],
  );
});

test("a response without limits[] falls back to the top-level windows", () => {
  const report = parseUsage({
    five_hour: { utilization: 2, resets_at: "2026-10-15T20:59:59Z" },
    seven_day: { utilization: 72, resets_at: null },
    seven_day_opus: null,
  });
  assert.deepEqual(
    report?.windows.map((w) => [w.key, w.percent]),
    [
      ["session", 2],
      ["weekly_all", 72],
    ],
  );
});

test("usage with extra credits off reports no spend", () => {
  const report = parseUsage({ limits: [], spend: { enabled: false } });
  assert.equal(report?.spend, null);
});

test("anything that is not a usage document is unavailable, not a crash", () => {
  assert.equal(parseUsage(null), null);
  assert.equal(parseUsage("nope"), null);
  assert.deepEqual(parseUsage({})?.windows, []);
});

const NOW = 1_800_000_000_000;
const USAGE = { limits: [{ kind: "session", percent: 30, resets_at: null }] };

interface Call {
  url: string;
  authorization?: string;
  body?: unknown;
}

async function fixture(options: {
  auth?: unknown;
  cache?: unknown;
  respond?: (call: Call) => Response;
}) {
  const dir = await mkdtemp(join(tmpdir(), "pios-usage-"));
  const authPath = join(dir, "auth.json");
  const cachePath = join(dir, "cache.json");
  const auth = options.auth ?? {
    anthropic: { type: "oauth", access: "a1", refresh: "r1", expires: NOW + 3_600_000 },
  };
  await writeFile(authPath, JSON.stringify(auth));
  if (options.cache) await writeFile(cachePath, JSON.stringify(options.cache));

  const calls: Call[] = [];
  let now = NOW;
  const usage = new ClaudeUsage({
    authPath,
    cachePath,
    now: () => now,
    fetch: (async (input: string | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      const call: Call = {
        url: String(input),
        authorization: headers.get("authorization") ?? undefined,
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      };
      calls.push(call);
      return options.respond?.(call) ?? Response.json(USAGE);
    }) as typeof fetch,
  });
  return {
    usage,
    calls,
    advance: (ms: number) => (now += ms),
    auth: async () => JSON.parse(await readFile(authPath, "utf8")),
    cache: async () => JSON.parse(await readFile(cachePath, "utf8")),
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
}

test("a fresh shared cache is served without touching the endpoint", async () => {
  const f = await fixture({ cache: { timestamp: NOW - 60_000, data: USAGE } });
  try {
    const report = await f.usage.get();
    assert.equal(report?.windows[0]?.percent, 30);
    assert.equal(report?.fetchedAt, NOW - 60_000);
    assert.equal(f.calls.length, 0);
  } finally {
    await f.cleanup();
  }
});

test("a stale cache is refetched and rewritten in the status bar's format", async () => {
  const f = await fixture({ cache: { timestamp: NOW - 10 * 60_000, data: {} } });
  try {
    const report = await f.usage.get();
    assert.equal(report?.windows[0]?.percent, 30);
    assert.equal(f.calls.length, 1);
    assert.equal(f.calls[0]?.authorization, "Bearer a1");
    assert.deepEqual(await f.cache(), { timestamp: NOW, data: USAGE });
  } finally {
    await f.cleanup();
  }
});

test("a 429 serves the stale report and escalates a backoff every reader honours", async () => {
  const f = await fixture({
    cache: { timestamp: NOW - 10 * 60_000, data: USAGE },
    respond: () => new Response("", { status: 429 }),
  });
  try {
    assert.equal((await f.usage.get())?.windows[0]?.percent, 30);
    let cache = await f.cache();
    assert.equal(cache.rate_limit_count, 1);
    assert.equal(cache.rate_limited_until, NOW + 5 * 60_000);
    assert.equal(cache.timestamp, NOW - 10 * 60_000);

    f.advance(60_000);
    await f.usage.get();
    assert.equal(f.calls.length, 1, "no request inside the backoff");

    f.advance(5 * 60_000);
    await f.usage.get();
    cache = await f.cache();
    assert.equal(cache.rate_limit_count, 2);
    assert.equal(cache.rate_limited_until, NOW + 6 * 60_000 + 10 * 60_000);
  } finally {
    await f.cleanup();
  }
});

test("an expired token is refreshed and written back without losing other providers", async () => {
  const f = await fixture({
    auth: {
      anthropic: { type: "oauth", access: "old", refresh: "r1", expires: NOW - 1 },
      opencode: { type: "api_key", key: "k" },
    },
    respond: (call) =>
      call.url.includes("/oauth/token")
        ? Response.json({ access_token: "new", refresh_token: "r2", expires_in: 3600 })
        : Response.json(USAGE),
  });
  try {
    await f.usage.get();
    assert.deepEqual(f.calls[0]?.body, {
      grant_type: "refresh_token",
      client_id: "9d1c250a-e61b-44d9-88ed-5944d1962f5e",
      refresh_token: "r1",
    });
    assert.equal(f.calls[1]?.authorization, "Bearer new");
    assert.deepEqual(await f.auth(), {
      anthropic: { type: "oauth", access: "new", refresh: "r2", expires: NOW + 3_300_000 },
      opencode: { type: "api_key", key: "k" },
    });
  } finally {
    await f.cleanup();
  }
});

test("a rejected token is refreshed once and the request retried", async () => {
  const f = await fixture({
    respond: (call) => {
      if (call.url.includes("/oauth/token")) {
        return Response.json({ access_token: "a2", expires_in: 3600 });
      }
      return call.authorization === "Bearer a1"
        ? new Response("", { status: 401 })
        : Response.json(USAGE);
    },
  });
  try {
    assert.equal((await f.usage.get())?.windows[0]?.percent, 30);
    assert.equal(f.calls.length, 3);
    assert.equal((await f.auth()).anthropic.refresh, "r1", "kept when not rotated");
  } finally {
    await f.cleanup();
  }
});

test("without a subscription login there is no usage and no request", async () => {
  const f = await fixture({ auth: { opencode: { type: "api_key", key: "k" } } });
  try {
    assert.equal(await f.usage.get(), null);
    assert.equal(f.calls.length, 0);
  } finally {
    await f.cleanup();
  }
});

test("concurrent readers share one request", async () => {
  const f = await fixture({});
  try {
    await Promise.all([f.usage.get(), f.usage.get(), f.usage.get()]);
    assert.equal(f.calls.length, 1);
  } finally {
    await f.cleanup();
  }
});
