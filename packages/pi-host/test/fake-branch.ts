import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { BranchSessionFile } from "../src/types.ts";
import { readStubSession, writeStubSession } from "./fake-session-file.ts";

let branches = 0;

/**
 * Branches a stub's session file, and like pi's writer only ever writes a new
 * one. The subprocess stub writes pi's JSONL; the in-process one a plain array.
 */
export const branchFakeSession: BranchSessionFile = ({ sessionFile, leafId }) => {
  const jsonl = sessionFile.endsWith(".jsonl");
  const stored = jsonl ? readStubSession(sessionFile) : null;
  const entries = stored?.entries ?? (JSON.parse(readFileSync(sessionFile, "utf8")) as { id: string }[]);
  const cut = entries.findIndex((entry) => entry.id === leafId);
  if (cut === -1) throw new Error(`Entry ${leafId} not found`);
  const kept = entries.slice(0, cut + 1);
  const id = `branch-${++branches}`;
  const path = join(dirname(sessionFile), `${id}.${jsonl ? "jsonl" : "json"}`);
  if (stored) writeStubSession(path, { id, cwd: stored.header?.cwd ?? "" }, stored.entries.slice(0, cut + 1));
  else writeFileSync(path, JSON.stringify(kept));
  return path;
};
