export type DiffLine = { kind: "same" | "add" | "remove"; text: string };

/** Above this many lines the table is not worth the memory on a phone. */
const MAX_LINES = 800;

/**
 * Line diff via LCS.
 *
 * Falls back to a whole-block replacement when either side is large: an exact
 * diff of a 5000-line file is not readable on a phone anyway, and the
 * quadratic table is not something to allocate in a render path.
 */
export function diffLines(before: string, after: string): DiffLine[] {
  const a = before.split("\n");
  const b = after.split("\n");
  if (a.length > MAX_LINES || b.length > MAX_LINES) {
    return [
      ...a.map((text): DiffLine => ({ kind: "remove", text })),
      ...b.map((text): DiffLine => ({ kind: "add", text })),
    ];
  }

  const lcs: number[][] = Array.from({ length: a.length + 1 }, () =>
    new Array<number>(b.length + 1).fill(0),
  );
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i]![j] = a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
    }
  }

  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      out.push({ kind: "same", text: a[i]! });
      i++;
      j++;
    } else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) {
      out.push({ kind: "remove", text: a[i]! });
      i++;
    } else {
      out.push({ kind: "add", text: b[j]! });
      j++;
    }
  }
  while (i < a.length) out.push({ kind: "remove", text: a[i++]! });
  while (j < b.length) out.push({ kind: "add", text: b[j++]! });
  return out;
}

export interface EditArgs {
  path?: string;
  /** Null for a whole-file write: there is nothing to diff against. */
  oldText: string | null;
  newText: string;
}

function one(args: unknown, path?: string): EditArgs | null {
  if (typeof args !== "object" || args === null) return null;
  const record = args as Record<string, unknown>;
  const oldText = record.oldText ?? record.old_text ?? record.old;
  const newText = record.newText ?? record.new_text ?? record.new ?? record.content;
  if (typeof newText !== "string") return null;
  return {
    path: typeof record.path === "string" ? record.path : path,
    oldText: typeof oldText === "string" ? oldText : null,
    newText,
  };
}

/**
 * Recognises edit- and write-shaped tool arguments.
 *
 * Multi-edit calls carry their replacements in `edits[]` and the target path
 * on the call itself, so the path is threaded down to each block.
 */
export function editBlocks(args: unknown): EditArgs[] {
  if (typeof args !== "object" || args === null) return [];
  const record = args as Record<string, unknown>;
  const path = typeof record.path === "string" ? record.path : undefined;
  if (Array.isArray(record.edits)) {
    return record.edits.map((edit) => one(edit, path)).filter((edit): edit is EditArgs => !!edit);
  }
  const single = one(record);
  return single ? [single] : [];
}
