import { createHash } from "node:crypto";
import { readFile, stat, writeFile } from "node:fs/promises";
import type { TextFile } from "@pios/protocol";

/**
 * Reading and writing text files inside a session's cwd, for the app's editor.
 *
 * Everything the client must not guess at lives here: what counts as text,
 * what is too big to edit, and how a save is made safe against the agent
 * rewriting the same path a second earlier.
 */

/** Above this, editing is refused: a phone cannot usefully edit it anyway. */
export const MAX_EDIT_BYTES = 1024 * 1024;
/** Enough of a head preview to see what the file is, without shipping it all. */
const PREVIEW_BYTES = 64 * 1024;
/** A NUL in this prefix means binary. */
const SNIFF_BYTES = 8 * 1024;
/** CodeMirror degrades badly on very long lines; minified bundles hit this. */
const MAX_LINE_CHARS = 50_000;

export function etagOf(bytes: Buffer): string {
  return `"${createHash("sha256").update(bytes).digest("hex")}"`;
}

export async function readTextFile(path: string): Promise<TextFile | null> {
  let info;
  try {
    info = await stat(path);
  } catch {
    return null;
  }
  if (!info.isFile()) return null;

  const bytes = await readFile(path);
  const etag = etagOf(bytes);
  const reason = refusal(bytes);
  // The preview is a head slice, so it can cut a multi-byte character in
  // half; the replacement character is honest here, and it is read-only.
  const slice = reason ? bytes.subarray(0, PREVIEW_BYTES) : bytes;
  const raw = slice.toString("utf8");

  return {
    etag,
    bytes: info.size,
    text: raw.replace(/\r\n/g, "\n"),
    eol: raw.includes("\r\n") ? "crlf" : "lf",
    trailingNewline: raw.endsWith("\n"),
    editable: !reason,
    ...(reason ? { reason } : {}),
  };
}

function refusal(bytes: Buffer): TextFile["reason"] | undefined {
  if (bytes.length > MAX_EDIT_BYTES) return "too_large";
  if (bytes.subarray(0, SNIFF_BYTES).includes(0)) return "binary";
  const text = bytes.toString("utf8");
  // Node substitutes U+FFFD for invalid sequences, so a round trip that
  // changes the byte length is the cheap test for "not valid UTF-8".
  if (Buffer.byteLength(text, "utf8") !== bytes.length) return "binary";
  for (const line of text.split("\n")) {
    if (line.length > MAX_LINE_CHARS) return "long_lines";
  }
  return undefined;
}

export type WriteOutcome =
  | { ok: true; etag: string; bytes: number; created: boolean }
  | { ok: false; error: "conflict"; etag: string }
  | { ok: false; error: "exists" }
  | { ok: false; error: "too_large" };

/**
 * Saves text back to disk.
 *
 * `ifMatch` is the etag the client loaded: a mismatch means the agent (or
 * anything else) wrote the file in between, and the client is asked what to
 * do rather than silently losing one of the two edits. No `ifMatch` at all
 * means "create", which refuses to clobber an existing file.
 */
export async function writeTextFile(
  path: string,
  text: string,
  options: { ifMatch?: string; eol?: "lf" | "crlf"; trailingNewline?: boolean },
): Promise<WriteOutcome> {
  let current: Buffer | null = null;
  try {
    current = await readFile(path);
  } catch {
    current = null;
  }

  if (!options.ifMatch && current) return { ok: false, error: "exists" };
  if (options.ifMatch && current) {
    const actual = etagOf(current);
    if (actual !== options.ifMatch && options.ifMatch !== "*") {
      return { ok: false, error: "conflict", etag: actual };
    }
  }

  let body = text.replace(/\r\n/g, "\n");
  if (options.trailingNewline && !body.endsWith("\n")) body += "\n";
  if (options.trailingNewline === false) body = body.replace(/\n+$/, "");
  if (options.eol === "crlf") body = body.replace(/\n/g, "\r\n");

  const bytes = Buffer.from(body, "utf8");
  if (bytes.length > MAX_EDIT_BYTES) return { ok: false, error: "too_large" };

  await writeFile(path, bytes);
  return { ok: true, etag: etagOf(bytes), bytes: bytes.length, created: !current };
}
