import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { BranchSessionFile } from "../src/types.ts";

let branches = 0;

/**
 * Branches the stubs' JSON session format.
 *
 * Both stubs persist a plain array of entries rather than pi's JSONL, so the
 * real writer cannot read them; this stands in for it and, like it, only ever
 * writes a new file.
 */
export const branchFakeSession: BranchSessionFile = ({ sessionFile, leafId }) => {
  const entries = JSON.parse(readFileSync(sessionFile, "utf8")) as { id: string }[];
  const cut = entries.findIndex((entry) => entry.id === leafId);
  if (cut === -1) throw new Error(`Entry ${leafId} not found`);
  const path = join(dirname(sessionFile), `branch-${++branches}.json`);
  writeFileSync(path, JSON.stringify(entries.slice(0, cut + 1)));
  return path;
};
