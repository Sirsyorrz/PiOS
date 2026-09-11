import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

/**
 * Which project directories may load their own extensions, settings and
 * packages.
 *
 * Trust belongs to a directory, not to a conversation: a session is started
 * lazily and restarted whenever it is woken, and asking the same question once
 * per session forever is not a decision, it is a nag.
 */

const VERSION = 1;

interface TrustFile {
  version: number;
  trusted: string[];
}

export class TrustStore {
  private readonly file: string;
  private readonly trusted = new Set<string>();

  constructor(file: string) {
    this.file = file;
    try {
      const raw = JSON.parse(readFileSync(file, "utf8")) as TrustFile;
      if (raw.version === VERSION) for (const path of raw.trusted ?? []) this.trusted.add(path);
    } catch {
      // No file yet, or one from another version. Nothing is trusted, which is
      // the safe answer to lose to.
    }
  }

  isTrusted(cwd: string): boolean {
    return this.trusted.has(resolve(cwd));
  }

  set(cwd: string, trusted: boolean): void {
    const path = resolve(cwd);
    if (trusted === this.trusted.has(path)) return;
    if (trusted) this.trusted.add(path);
    else this.trusted.delete(path);
    this.persist();
  }

  private persist(): void {
    const payload: TrustFile = { version: VERSION, trusted: [...this.trusted] };
    try {
      mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
      const temporary = `${this.file}.tmp`;
      writeFileSync(temporary, JSON.stringify(payload, null, 2), { mode: 0o600 });
      renameSync(temporary, this.file);
    } catch (error) {
      console.error("[pios] could not save trust settings", error);
    }
  }
}
