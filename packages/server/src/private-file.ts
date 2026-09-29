import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Writes JSON only the owner can read.
 *
 * The chmod is not redundant with `mode`: `mode` applies only when the file is
 * created, and an older file may have looser permissions.
 */
export function writePrivateJson(path: string, data: unknown): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, JSON.stringify(data, null, 2), { mode: 0o600 });
  chmodSync(path, 0o600);
}
