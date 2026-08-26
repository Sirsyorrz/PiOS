import { z } from "zod";
import type { ExtensionUiRequest } from "./events.ts";

/**
 * The non-blocking half of pi's extension UI: what an extension has asked to
 * be *shown*, as opposed to what it is waiting to be *answered*.
 *
 * Modelled as last-value-wins state rather than a stream of events, because
 * that is how pi keys it: `setStatus`/`setWidget` replace by key, `setTitle`
 * replaces outright. A client that reconnects needs the current values, not
 * the history of how they got there.
 */

/** An extension can call these in a loop, so both are capped. */
const MAX_KEYS = 16;
const MAX_TEXT = 500;
const MAX_WIDGET_LINES = 50;

export const StatusItemSchema = z.object({ key: z.string(), text: z.string() });

export const WidgetItemSchema = z.object({
  key: z.string(),
  lines: z.array(z.string()),
  placement: z.enum(["aboveEditor", "belowEditor"]).optional(),
});

export const SessionPresentationSchema = z.object({
  title: z.string().optional(),
  /** Insertion-ordered, so chips do not reshuffle on every update. */
  status: z.array(StatusItemSchema),
  widgets: z.array(WidgetItemSchema),
  /** An extension asked to replace the composer's contents. */
  editorText: z.string().optional(),
});

export type StatusItem = z.infer<typeof StatusItemSchema>;
export type WidgetItem = z.infer<typeof WidgetItemSchema>;
export type SessionPresentation = z.infer<typeof SessionPresentationSchema>;

export function emptyPresentation(): SessionPresentation {
  return { status: [], widgets: [] };
}

/**
 * Folds one request into the presentation state.
 *
 * Returns the same object when nothing changed, so callers can skip a
 * broadcast on a repeated `setStatus` with identical text. Shared by the
 * daemon and the client so both derive the same state from the same frames.
 */
export function applyPresentation(
  state: SessionPresentation,
  request: ExtensionUiRequest,
): SessionPresentation {
  switch (request.method) {
    case "setTitle": {
      const title = clamp(request.title);
      return title === state.title ? state : { ...state, title };
    }
    case "set_editor_text": {
      const editorText = clamp(request.text);
      return editorText === state.editorText ? state : { ...state, editorText };
    }
    case "setStatus": {
      if (!request.statusKey) return state;
      const text = clamp(request.statusText);
      // pi clears a status by sending no text; an empty chip is worse than none.
      const next = upsert(state.status, request.statusKey, text ? { key: request.statusKey, text } : null);
      return next === state.status ? state : { ...state, status: next };
    }
    case "setWidget": {
      if (!request.widgetKey) return state;
      const lines = request.widgetLines?.slice(0, MAX_WIDGET_LINES).map((line) => clamp(line) ?? "");
      const next = upsert(
        state.widgets,
        request.widgetKey,
        lines ? { key: request.widgetKey, lines, placement: request.widgetPlacement } : null,
      );
      return next === state.widgets ? state : { ...state, widgets: next };
    }
    default:
      return state;
  }
}

// CSI/SGR, OSC with either terminator, and any escape left over.
const ANSI = /\u001B\[[0-9;:?]*[ -/]*[@-~]|\u001B\][^\u0007\u001B]*(?:\u0007|\u001B\\)|\u001B/g;

/**
 * Removes terminal styling from extension text.
 *
 * Extensions colour their status lines for the TUI through pi's theme, and
 * those escapes reach every client verbatim. A DOM cannot render them, so they
 * would show up as literal `[38;5;167m` noise.
 */
export function stripAnsi(text: string): string {
  return text.replace(ANSI, "");
}

/** Replaces by key, keeps insertion order, drops on a null value. */
function upsert<T extends { key: string }>(items: T[], key: string, value: T | null): T[] {
  const index = items.findIndex((item) => item.key === key);
  if (!value) return index === -1 ? items : items.filter((item) => item.key !== key);
  if (index === -1) {
    return items.length >= MAX_KEYS ? items : [...items, value];
  }
  if (JSON.stringify(items[index]) === JSON.stringify(value)) return items;
  const next = [...items];
  next[index] = value;
  return next;
}

function clamp(text: string | undefined): string | undefined {
  if (text === undefined) return undefined;
  const plain = stripAnsi(text);
  return plain.length > MAX_TEXT ? plain.slice(0, MAX_TEXT) : plain;
}
