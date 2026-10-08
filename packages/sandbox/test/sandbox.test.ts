import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { after, before, describe, it } from "node:test";
import { startSandbox, type Sandbox } from "../src/sandbox.ts";

describe("sandbox", () => {
  let sandbox: Sandbox;

  before(async () => {
    sandbox = await startSandbox({ scenario: "git-dirty" });
  });
  after(async () => {
    await sandbox.close();
  });

  const get = (path: string) =>
    fetch(`${sandbox.baseUrl}${path}`, {
      headers: { authorization: `Bearer ${sandbox.deviceToken}` },
    });

  it("pairs a device and registers the scenario's sessions", async () => {
    const session = sandbox.server.registry.get("sbx-git");
    assert.ok(session);
    assert.equal(session.info.name, "feature/git-view");
  });

  it("seeds the transcript where the session host finds it", async () => {
    const page = await sandbox.server.registry.get("sbx-git")!.getEntries();
    assert.equal(page.entries.length, 2);
    assert.equal(page.entries[0]?.message?.role, "user");
  });

  it("builds a real repository the git routes can read", async () => {
    const response = await get("/git/status?session=sbx-git&fresh=1");
    const { status } = (await response.json()) as { status: { branch: string; files: { path: string }[] } };
    assert.equal(status.branch, "feature/git-view");
    const paths = status.files.map((f) => f.path).sort();
    // git reports an entirely untracked directory as the directory.
    assert.deepEqual(paths, ["docs/guide.md", "legacy.txt", "notes.md", "src/index.ts", "tmp/"]);
  });

  it("keeps every byte it writes inside its own temp directory", async () => {
    assert.ok(sandbox.dir.includes("pios-sandbox-"));
    assert.ok(sandbox.sessions.every((s) => s.cwd.startsWith(sandbox.dir)));
    const dir = sandbox.dir;
    await sandbox.close();
    assert.equal(existsSync(dir), false);
    sandbox = await startSandbox({ scenario: "empty" });
  });
});

describe("a session outside a repository", () => {
  let sandbox: Sandbox;

  before(async () => {
    sandbox = await startSandbox({ scenario: "git-none" });
  });
  after(async () => {
    await sandbox.close();
  });

  const call = (path: string, init?: RequestInit) =>
    fetch(`${sandbox.baseUrl}${path}`, {
      ...init,
      headers: { authorization: `Bearer ${sandbox.deviceToken}` },
    });

  it("answers with a null status rather than an error", async () => {
    const response = await call("/git/status?session=sbx-plain&fresh=1");
    assert.equal(response.status, 200);
    assert.equal(((await response.json()) as { status: unknown }).status, null);
  });

  it("initializes on request, and then has a status", async () => {
    const init = await call("/git/action?session=sbx-plain", {
      method: "POST",
      body: JSON.stringify({ type: "init" }),
    });
    assert.equal(init.status, 200);
    const { status } = (await init.json()) as { status: { root: string } | null };
    assert.ok(status, "the action reports the repository it just made");
    assert.ok(status!.root.startsWith(sandbox.dir), "and only inside the sandbox");
  });
});

describe("cold sessions", () => {
  let sandbox: Sandbox;

  before(async () => {
    sandbox = await startSandbox({ scenario: "cold" });
  });
  after(async () => {
    await sandbox.close();
  });

  it("reaps an idle session and keeps it listable", async () => {
    const session = sandbox.server.registry.get("sbx-cold");
    assert.ok(session, "a reaped session is still a session");
    assert.equal(session.info.status, "cold");
    assert.equal(session.info.cwd.length > 0, true);
  });

  it("reads its transcript from disk without waking", async () => {
    const session = sandbox.server.registry.get("sbx-cold")!;
    const page = await session.getEntries();
    assert.equal(page.entries.length, 2);
    assert.equal(session.info.status, "cold");
  });

  it("wakes on the next command, with its transcript intact", async () => {
    const session = sandbox.server.registry.get("sbx-cold")!;
    await session.listModels({ all: false });
    assert.equal(session.info.status !== "cold", true, "the command brought it back");
    assert.equal((await session.getEntries()).entries.length, 2);
  });
});
