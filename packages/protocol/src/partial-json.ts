/**
 * Best-effort parse of a JSON document that is still being streamed.
 *
 * Tool arguments arrive as raw text deltas, so waiting for the closing brace
 * means showing nothing at all for the whole of a long argument. Closing what
 * is still open yields a value the UI can render on every delta: a half-typed
 * path is a useful preview, an empty card is not.
 *
 * Only unambiguous fragments survive. A key with no value yet, and a literal
 * that could still grow (`tr`, `12`), are dropped rather than guessed at, so
 * the preview never shows a value the agent did not send. A string is the one
 * exception: its content is already final up to the cut, so it is closed and
 * kept.
 */
export function parsePartialJson(text: string): unknown {
  const trimmed = text.trim();
  if (trimmed === "") return undefined;
  try {
    return JSON.parse(trimmed);
  } catch {
    try {
      return JSON.parse(repair(trimmed));
    } catch {
      return undefined;
    }
  }
}

type Frame = { type: "obj" | "arr"; expect: "key" | "colon" | "value" | "comma" };

/** Truncates at the last point that cannot change, then closes what is open. */
function repair(text: string): string {
  const stack: Frame[] = [];
  let cut = 0;
  let cutClosers = "";
  const record = (index: number) => {
    cut = index;
    cutClosers = closers(stack);
  };

  let i = 0;
  while (i < text.length) {
    const char = text[i] as string;
    const top = stack[stack.length - 1];

    if (isSpace(char)) {
      i += 1;
    } else if (char === ":") {
      if (top?.type === "obj") top.expect = "value";
      i += 1;
    } else if (char === ",") {
      if (top) top.expect = top.type === "obj" ? "key" : "value";
      i += 1;
    } else if (char === "{" || char === "[") {
      stack.push(char === "{" ? { type: "obj", expect: "key" } : { type: "arr", expect: "value" });
      i += 1;
      record(i);
    } else if (char === "}" || char === "]") {
      stack.pop();
      i += 1;
      valueDone(stack);
      record(i);
    } else if (char === '"') {
      const isKey = top?.type === "obj" && top.expect !== "value";
      const end = stringEnd(text, i);
      if (end === -1) {
        // A half-written key names nothing, so the whole member is dropped.
        if (isKey) break;
        return `${text.slice(0, i)}${closeString(text.slice(i))}${closers(stack)}`;
      }
      i = end + 1;
      if (isKey) {
        if (top) top.expect = "colon";
      } else {
        valueDone(stack);
        record(i);
      }
    } else {
      const start = i;
      while (i < text.length && !/[,\]}\s]/.test(text[i] as string)) i += 1;
      // A literal that runs to the end of the buffer may still grow: `1` can
      // become `12`, `tr` can become `true`. Only a delimited one is final.
      if (i < text.length && isComplete(text.slice(start, i))) {
        valueDone(stack);
        record(i);
      } else break;
    }
  }

  return `${text.slice(0, cut)}${cutClosers}`;
}

function valueDone(stack: Frame[]) {
  const top = stack[stack.length - 1];
  if (top) top.expect = "comma";
}

/** The brackets that would close every open container, innermost first. */
function closers(stack: Frame[]): string {
  return stack.map((frame) => (frame.type === "obj" ? "}" : "]")).reverse().join("");
}

/** Terminates an unfinished string, dropping an escape that is cut in half. */
function closeString(fragment: string): string {
  const safe = fragment
    .replace(/\\u[0-9a-fA-F]{0,3}$/, "")
    .replace(/(^|[^\\])(\\\\)*\\$/, "$1$2");
  return `${safe}"`;
}

/** Index of the closing quote of the string starting at `start`, or -1. */
function stringEnd(text: string, start: number): number {
  for (let i = start + 1; i < text.length; i += 1) {
    const char = text[i];
    if (char === "\\") i += 1;
    else if (char === '"') return i;
  }
  return -1;
}

function isComplete(literal: string): boolean {
  return literal === "true" || literal === "false" || literal === "null" ||
    /^-?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(literal);
}

function isSpace(char: string): boolean {
  return char === " " || char === "\t" || char === "\n" || char === "\r";
}
