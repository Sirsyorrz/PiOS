import { StringDecoder } from "node:string_decoder";

export class JsonlLineTooLongError extends Error {
  readonly limit: number;

  constructor(limit: number) {
    super(`JSONL record exceeded ${limit} bytes without a newline`);
    this.name = "JsonlLineTooLongError";
    this.limit = limit;
  }
}

export interface JsonlFramerOptions {
  /** Guard against an unterminated record consuming all memory. */
  maxLineBytes?: number;
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
  private buffer = "";
  private readonly decoder = new StringDecoder("utf8");
  private readonly maxLineBytes: number;

  constructor(options: JsonlFramerOptions = {}) {
    this.maxLineBytes = options.maxLineBytes ?? DEFAULT_MAX_LINE_BYTES;
  }

  push(chunk: Uint8Array | string): string[] {
    this.buffer +=
      typeof chunk === "string" ? chunk : this.decoder.write(Buffer.from(chunk));
    return this.drain();
  }

  /** Flush the tail. A final record without a trailing LF is still returned. */
  end(): string[] {
    this.buffer += this.decoder.end();
    const records = this.drain();
    if (this.buffer.length > 0) {
      records.push(stripCr(this.buffer));
      this.buffer = "";
    }
    return records;
  }

  private drain(): string[] {
    const records: string[] = [];
    for (;;) {
      const lf = this.buffer.indexOf("\n");
      if (lf === -1) break;
      const record = stripCr(this.buffer.slice(0, lf));
      this.buffer = this.buffer.slice(lf + 1);
      // Skip keepalive blank lines rather than emitting unparseable records.
      if (record.length > 0) records.push(record);
    }
    if (Buffer.byteLength(this.buffer, "utf8") > this.maxLineBytes) {
      this.buffer = "";
      throw new JsonlLineTooLongError(this.maxLineBytes);
    }
    return records;
  }
}

/** Producers must emit LF-terminated records; consumers may receive CRLF. */
export function encodeJsonl(value: unknown): string {
  return JSON.stringify(value) + "\n";
}

function stripCr(record: string): string {
  return record.endsWith("\r") ? record.slice(0, -1) : record;
}
