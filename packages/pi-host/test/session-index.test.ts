import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { SessionIndex } from "../src/session-index.ts";

/**
 * pi stores sessions one directory per project under the root, and its own
 * `sessionDir` argument names the project directory, not the root. Listing the
 * root directly finds nothing, which is the bug this pins.
 */
function seed(root: string, cwd: string, text: string): void {
  const safe = `--${cwd.replace(/^\//, "").replace(/\//g, "-")}--`;
  const manager = SessionManager.create(cwd, join(root, safe));
  manager.appendMessage({ role: "user", content: text, timestamp: Date.now() });
  // pi holds the file back until a turn produces an assistant message, so a
  // user prompt alone leaves nothing on disk to find.
  manager.appendMessage({
    role: "assistant",
    content: [{ type: "text", text: "ok" }],
    timestamp: Date.now(),
    api: "anthropic-messages",
    provider: "test",
    model: "test",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costUSD: 0 },
    stopReason: "stop",
  } as never);
}

test("sessions are found under a session root, not just a project directory", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pios-discovery-"));
  try {
    const root = join(dir, "sessions");
    seed(root, join(dir, "alpha"), "from the TUI");
    seed(root, join(dir, "beta"), "another project");

    const index = new SessionIndex({ sessionDir: root });

    const all = (await index.list({})).sessions;
    assert.equal(all.length, 2);
    assert.ok(all.every((session) => session.path.endsWith(".jsonl")));

    const alpha = (await index.list({ cwd: join(dir, "alpha") })).sessions;
    assert.equal(alpha.length, 1);
    assert.equal(alpha[0]?.preview, "from the TUI");
    assert.equal(alpha[0]?.cwd, join(dir, "alpha"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the index pages, filters, and seeds itself across restarts", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pios-index-"));
  try {
    const root = join(dir, "sessions");
    seed(root, join(dir, "alpha"), "needle in here");
    seed(root, join(dir, "beta"), "something else");
    const cacheFile = join(dir, "session-index.json");

    const index = new SessionIndex({ sessionDir: root, cacheFile });
    const first = await index.list({ limit: 1 });
    assert.equal(first.sessions.length, 1);
    assert.equal(first.total, 2);
    assert.equal(first.hasMore, true);

    const second = await index.list({ limit: 1, offset: 1 });
    assert.equal(second.hasMore, false);
    assert.notEqual(second.sessions[0]?.id, first.sessions[0]?.id);

    const hit = await index.list({ query: "NEEDLE" });
    assert.equal(hit.sessions.length, 1);
    assert.equal(hit.sessions[0]?.preview, "needle in here");
    assert.equal(index.fileFor(hit.sessions[0]!.id), hit.sessions[0]!.path);

    // A fresh index must answer from the seed file alone, without a rescan.
    await new Promise((done) => setTimeout(done, 50));
    const restarted = new SessionIndex({ sessionDir: join(dir, "gone"), cacheFile });
    assert.equal(restarted.fileFor(hit.sessions[0]!.id), undefined);
    await restarted.list({});
    assert.equal(restarted.fileFor(hit.sessions[0]!.id), hit.sessions[0]!.path);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** A session file as pi writes it, with entry timestamps under the test's control. */
function writeSession(
  root: string,
  id: string,
  lines: { role?: string; type?: string; name?: string; at: number; text?: string }[],
  mtime: number,
): string {
  const dir = join(root, `--${id}--`);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${id}.jsonl`);
  const records = [
    { type: "session", version: 3, id, cwd: `/work/${id}`, timestamp: new Date(lines[0]!.at).toISOString() },
    ...lines.map((line, index) =>
      line.type
        ? { type: line.type, id: `${id}-${index}`, parentId: null, name: line.name, timestamp: new Date(line.at).toISOString() }
        : {
            type: "message",
            id: `${id}-${index}`,
            parentId: null,
            timestamp: new Date(line.at).toISOString(),
            message: { role: line.role, content: [{ type: "text", text: line.text ?? "x" }] },
          },
    ),
  ];
  writeFileSync(path, records.map((record) => JSON.stringify(record)).join("\n") + "\n");
  utimesSync(path, mtime / 1000, mtime / 1000);
  return path;
}

test("the list is ordered by the last thing the user did, not by the last write", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pios-index-order-"));
  try {
    const root = join(dir, "sessions");
    const t = Date.UTC(2026, 0, 1);
    // Prompted long ago, then an unattended run that is still writing.
    writeSession(
      root,
      "unattended",
      [
        { role: "user", at: t, text: "go refactor everything" },
        ...Array.from({ length: 50 }, (_, i) => ({ role: "assistant", at: t + 60_000 * (i + 10) })),
      ],
      t + 3_600_000,
    );
    // Prompted a minute ago and answered, then left.
    writeSession(
      root,
      "just-left",
      [
        { role: "user", at: t + 1_800_000 },
        { role: "assistant", at: t + 1_810_000 },
      ],
      t + 1_810_000,
    );
    writeSession(root, "old", [{ role: "user", at: t - 86_400_000 }], t - 86_400_000);

    const index = new SessionIndex({ sessionDir: root });
    const page = await index.list({ limit: 2 });
    assert.deepEqual(
      page.sessions.map((session) => session.id),
      ["just-left", "unattended"],
    );
    assert.equal(page.hasMore, true);
    assert.equal(page.sessions[1]!.activeAt, t);

    const rest = await index.list({ limit: 2, offset: 2 });
    assert.deepEqual(rest.sessions.map((session) => session.id), ["old"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a rename past the head of a large session still names it", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pios-index-name-"));
  try {
    const root = join(dir, "sessions");
    const t = Date.UTC(2026, 0, 1);
    const filler = "y".repeat(2000);
    writeSession(
      root,
      "big",
      [
        { role: "user", at: t, text: "first" },
        ...Array.from({ length: 100 }, (_, i) => ({ role: "assistant", at: t + i, text: filler })),
        { type: "session_info", name: "renamed late", at: t + 500 },
        { role: "user", at: t + 600, text: "later" },
      ],
      t + 600,
    );
    const [record] = (await new SessionIndex({ sessionDir: root }).list({})).sessions;
    assert.equal(record?.name, "renamed late");
    assert.equal(record?.activeAt, t + 600);
    assert.equal(record?.preview, "first");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
