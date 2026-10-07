import { StringDecoder } from "node:string_decoder";

export interface JsonlFramerOptions {
  /** Guard against an unterminated record consuming all memory. */
  maxLineBytes?: number;
  /**
   * Called when a record passes the guard. The record is dropped and framing
   * resumes after its LF: one oversized record must not take down whoever is
   * reading, nor misalign every record after it.
   */
  onOverflow?: (limit: number) => void;
}

const DEFAULT_MAX_LINE_BYTES = 64 * 1024 * 1024;

/**
 * Splits a byte stream into JSONL records on LF only.
 *
 * Node's `readline` also breaks on U+2028 and U+2029, which are legal
 * unescaped inside JSON strings, so it corrupts records that contain them.
 * Multi-byte characters split across chunk boundaries are held by the decoder
 * until complete.
 */
export class JsonlFramer {
  /** Pieces of the current unterminated record, joined only once it ends. */
  private parts: string[] = [];
  private partBytes = 0;
  private discarding = false;
  private readonly decoder = new StringDecoder("utf8");
  private readonly maxLineBytes: number;
  private readonly onOverflow?: (limit: number) => void;

  constructor(options: JsonlFramerOptions = {}) {
    this.maxLineBytes = options.maxLineBytes ?? DEFAULT_MAX_LINE_BYTES;
    this.onOverflow = options.onOverflow;
  }

  push(chunk: Uint8Array | string): string[] {
    const text = typeof chunk === "string" ? chunk : this.decoder.write(Buffer.from(chunk));
    return this.drain(text);
  }

  /** Flush the tail. A final record without a trailing LF is still returned. */
  end(): string[] {
    const records = this.drain(this.decoder.end());
    if (!this.discarding && this.parts.length > 0) {
      const record = stripCr(this.parts.join(""));
      if (record.length > 0) records.push(record);
    }
    this.reset();
    return records;
  }

  /** Scans only the new text, so a long record costs linear time to frame. */
  private drain(text: string): string[] {
    const records: string[] = [];
    let from = 0;
    for (;;) {
      const lf = text.indexOf("\n", from);
      if (lf === -1) break;
      if (!this.discarding) {
        this.parts.push(text.slice(from, lf));
        const record = stripCr(this.parts.join(""));
        // Skip keepalive blank lines rather than emitting unparseable records.
        if (record.length > 0) records.push(record);
      }
      this.reset();
      from = lf + 1;
    }
    if (from < text.length && !this.discarding) {
      const rest = text.slice(from);
      this.parts.push(rest);
      this.partBytes += Buffer.byteLength(rest, "utf8");
      if (this.partBytes > this.maxLineBytes) {
        this.reset();
        this.discarding = true;
        this.onOverflow?.(this.maxLineBytes);
      }
    }
    return records;
  }

  private reset(): void {
    this.parts = [];
    this.partBytes = 0;
    this.discarding = false;
  }
}

/** Producers must emit LF-terminated records; consumers may receive CRLF. */
export function encodeJsonl(value: unknown): string {
  return JSON.stringify(value) + "\n";
}

function stripCr(record: string): string {
  return record.endsWith("\r") ? record.slice(0, -1) : record;
}
