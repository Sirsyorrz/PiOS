import type { SessionEntry } from "@pios/protocol";

/**
 * Entry builders for scenarios.
 *
 * A seeded transcript is written straight into the stub pi's state file, so
 * the shapes here are the ones pi persists, not the ones the wire streams.
 */

export interface EntrySeed {
  type?: string;
  message: SessionEntry["message"];
}

export const user = (text: string): EntrySeed => ({
  message: { role: "user", content: [{ type: "text", text }] },
});

/** Assistant turn that is only prose. */
export const say = (text: string): EntrySeed => ({
  message: {
    role: "assistant",
    model: "deep-1",
    provider: "acme",
    content: [{ type: "text", text }],
  },
});

let failures = 0;

/**
 * An attempt the provider refused. Has no content: pi records only the error.
 * Timestamped apart, as pi's are, or identical retries would dedupe as one.
 */
export const fail = (errorMessage: string): EntrySeed => ({
  message: {
    timestamp: Date.UTC(2025, 0, 1) + ++failures,
    role: "assistant",
    model: "deep-1",
    provider: "acme",
    content: [],
    stopReason: "error",
    errorMessage,
  },
});

/** Prose that ended some other way than a normal stop: `aborted` or `length`. */
export const cut = (text: string, stopReason: "aborted" | "length"): EntrySeed => ({
  message: {
    role: "assistant",
    model: "deep-1",
    provider: "acme",
    content: [{ type: "text", text }],
    stopReason,
  },
});

export const think = (thinking: string, text: string): EntrySeed => ({
  message: {
    role: "assistant",
    model: "deep-1",
    provider: "acme",
    content: [
      { type: "thinking", thinking },
      { type: "text", text },
    ],
  },
});

export const toolCall = (id: string, name: string, args: unknown): EntrySeed => ({
  message: {
    role: "assistant",
    model: "deep-1",
    provider: "acme",
    content: [{ type: "toolCall", id, name, arguments: args }],
  },
});

export const toolResult = (
  id: string,
  name: string,
  text: string,
  isError = false,
): EntrySeed => ({
  message: {
    role: "toolResult",
    toolCallId: id,
    toolName: name,
    isError,
    content: [{ type: "text", text }],
  },
});

/** A call and its result, the pair every tool card in the UI renders. */
export const tool = (
  id: string,
  name: string,
  args: unknown,
  output: string,
  isError = false,
): EntrySeed[] => [toolCall(id, name, args), toolResult(id, name, output, isError)];

export const bash = (command: string, output: string, exitCode = 0): EntrySeed => ({
  message: { role: "bashExecution", command, output, exitCode },
});

/** Materialises seeds into the linked entry list the stub pi persists. */
export function buildEntries(prefix: string, seeds: EntrySeed[]): SessionEntry[] {
  const entries: SessionEntry[] = [];
  let parentId: string | null = null;
  // pi stamps every message, and clients tell repeated turns apart by it:
  // unstamped, two identical answers would read as one.
  const start = Date.UTC(2026, 0, 1);
  seeds.forEach((seed, index) => {
    const id = `${prefix}-${index + 1}`;
    const message = seed.message ? { timestamp: start + index * 1000, ...seed.message } : seed.message;
    entries.push({ id, parentId, type: seed.type ?? "message", message });
    parentId = id;
  });
  return entries;
}
