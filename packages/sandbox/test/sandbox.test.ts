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
