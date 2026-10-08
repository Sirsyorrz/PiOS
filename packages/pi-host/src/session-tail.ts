import { open, stat } from "node:fs/promises";

/**
 * Reads a session file backwards, newest entry first.
 *
 * What changes in a session in use is at its end, which can be megabytes from
 * the head: the last thing the user did, a rename, the turn that just ended.
 * `visit` returns true once it has seen enough. Bounded by `maxBytes`, because
 * a long run of tool output can bury what is being looked for arbitrarily deep.
 */
export async function scanTail(
  path: string,
  visit: (entry: Record<string, unknown>) => boolean | void,
  maxBytes = 512 * 1024,
): Promise<void> {
  const handle = await open(path, "r");
  try {
    const size = (await stat(path)).size;
    let end = size;
    let carry = Buffer.alloc(0);
    while (end > 0 && size - end < maxBytes) {
      const start = Math.max(0, end - CHUNK);
      const chunk = Buffer.alloc(end - start);
      await handle.read(chunk, 0, chunk.length, start);
      end = start;
      // Joined as bytes and cut at an LF byte before decoding: a chunk edge
      // can split a multi-byte character, and only LF frames a record.
      let bytes = Buffer.concat([chunk, carry]);
      carry = Buffer.alloc(0);
      if (start > 0) {
        const first = bytes.indexOf(0x0a);
        // One record longer than the chunk: carried whole into the next read.
        if (first === -1) {
          carry = bytes;
          continue;
        }
        carry = bytes.subarray(0, first);
        bytes = bytes.subarray(first + 1);
      }
      const lines = bytes.toString("utf8").split("\n");
      for (let i = lines.length - 1; i >= 0; i--) {
        const entry = parseLine(lines[i]!);
        if (entry && visit(entry)) return;
      }
    }
  } finally {
    await handle.close();
  }
}

const CHUNK = 64 * 1024;

function parseLine(line: string): Record<string, unknown> | null {
  if (!line.trim()) return null;
  try {
    return JSON.parse(line) as Record<string, unknown>;
  } catch {
    // A line cut by the byte budget, or a partial write from a live pi.
    return null;
  }
}

/** An entry's time, from the entry or, for older files, from its message. */
export function entryTimestamp(entry: Record<string, unknown>): number | undefined {
  const raw = entry.timestamp ?? (entry.message as { timestamp?: unknown } | undefined)?.timestamp;
  const at = typeof raw === "number" ? raw : Date.parse(String(raw));
  return Number.isFinite(at) ? at : undefined;
}
