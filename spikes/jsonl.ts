import { StringDecoder } from "node:string_decoder";

/**
 * LF-only JSONL splitter. Node `readline` also breaks on U+2028/U+2029, which
 * are legal inside JSON strings, so it cannot be used on this stream.
 */
export class JsonlFramer {
  private buffer = "";
  private readonly decoder = new StringDecoder("utf8");

  constructor(private readonly maxLineBytes = 64 * 1024 * 1024) {}

  push(chunk: Buffer | string): string[] {
    this.buffer += typeof chunk === "string" ? chunk : this.decoder.write(chunk);
    return this.drain();
  }

  end(): string[] {
    this.buffer += this.decoder.end();
    const lines = this.drain();
    if (this.buffer.length > 0) {
      lines.push(stripCr(this.buffer));
      this.buffer = "";
    }
    return lines;
  }

  private drain(): string[] {
    const lines: string[] = [];
    for (;;) {
      const nl = this.buffer.indexOf("\n");
      if (nl === -1) break;
      lines.push(stripCr(this.buffer.slice(0, nl)));
      this.buffer = this.buffer.slice(nl + 1);
    }
    if (this.buffer.length > this.maxLineBytes) {
      throw new Error(`JSONL line exceeded ${this.maxLineBytes} bytes`);
    }
    return lines;
  }
}

function stripCr(line: string): string {
  return line.endsWith("\r") ? line.slice(0, -1) : line;
}
