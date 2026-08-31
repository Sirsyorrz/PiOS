import { SessionManager } from "@earendil-works/pi-coding-agent";
import { projectSessionDir } from "./session-paths.ts";
import type { BranchSessionFile } from "./types.ts";

/**
 * Branches a session file with pi's own writer.
 *
 * Opened from disk rather than driven through the live agent: branching must
 * not disturb the session it copies from, and the file is current because pi
 * appends every entry as it makes it.
 */
export function branchWithPi(sessionDir?: string): BranchSessionFile {
  return ({ sessionFile, cwd, leafId }) => {
    const dir = sessionDir ? projectSessionDir(cwd, sessionDir) : undefined;
    return SessionManager.open(sessionFile, dir, cwd).createBranchedSession(leafId);
  };
}
