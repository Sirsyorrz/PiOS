import { readFileSync, writeFileSync } from "node:fs";

/**
 * pi's on-disk session format, as far as the stubs need it: a `session` header
 * line, then one entry per line.
 *
 * Writing the real format rather than a private one is what lets the daemon
 * index, list and read a stub's sessions exactly as it does pi's, including a
 * session no process has ever been started for.
 */

export interface StubHeader {
  id: string;
  cwd: string;
  timestamp?: string;
}

export interface StubEntry {
  id: string;
  parentId: string | null;
  type: string;
  timestamp?: string;
  [key: string]: unknown;
}

export function readStubSession(path: string): { header: StubHeader | null; entries: StubEntry[] } {
  let header: StubHeader | null = null;
  const entries: StubEntry[] = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.trim()) continue;
    const record = JSON.parse(line) as Record<string, unknown>;
    if (record.type === "session") header = record as unknown as StubHeader;
    else entries.push(record as StubEntry);
  }
  return { header, entries };
}

export function writeStubSession(path: string, header: StubHeader, entries: StubEntry[]): void {
  const lines = [
    { type: "session", version: 3, timestamp: header.timestamp ?? new Date().toISOString(), ...header },
    ...entries.map((entry) => ({ timestamp: new Date().toISOString(), ...entry })),
  ];
  writeFileSync(path, lines.map((line) => JSON.stringify(line)).join("\n") + "\n");
}
