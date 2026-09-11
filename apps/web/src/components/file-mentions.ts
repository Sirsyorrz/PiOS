import { useEffect, useState } from "react";
import { useFileAccess } from "../files.ts";

/** A token being completed: what was typed, and where it sits in the text. */
export interface Mention {
  query: string;
  start: number;
  end: number;
}

/**
 * The `@token` under the caret, or null.
 *
 * Anchored to a word start so an email address or a `foo@bar` argument does
 * not open the picker, and stopped at whitespace so only the token being
 * typed is replaced.
 */
export function mentionAt(text: string, caret: number): Mention | null {
  const before = text.slice(0, caret);
  const at = before.lastIndexOf("@");
  if (at === -1) return null;
  if (at > 0 && !/\s/.test(before[at - 1]!)) return null;
  const query = before.slice(at + 1);
  if (/\s/.test(query)) return null;
  return { query, start: at, end: caret };
}

/** Matching paths for a mention, or an empty list while it is not open. */
export function useFileMatches(mention: Mention | null): string[] {
  const access = useFileAccess();
  const query = mention?.query ?? null;
  const [matches, setMatches] = useState<string[]>([]);

  useEffect(() => {
    if (query === null || !access?.baseUrl) {
      setMatches([]);
      return;
    }
    let live = true;
    // Typing outruns the index on a big repo; a short debounce keeps the
    // request rate at roughly one per pause rather than one per keystroke.
    const timer = setTimeout(() => {
      const url = new URL("/files", access.baseUrl!);
      url.searchParams.set("session", access.sessionId);
      url.searchParams.set("q", query);
      void fetch(url, { headers: { authorization: `Bearer ${access.deviceToken}` } })
        .then((response) => (response.ok ? response.json() : { files: [] }))
        .then((body: { files?: string[] }) => {
          if (live) setMatches(body.files ?? []);
        })
        // A failed lookup shows no menu: the text typed is still valid input.
        .catch(() => live && setMatches([]));
    }, 80);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [query, access?.baseUrl, access?.deviceToken, access?.sessionId]);

  return query === null ? [] : matches;
}

/** Replaces the mention token with the chosen path, leaving a trailing space. */
export function applyMention(text: string, mention: Mention, path: string): string {
  // Quoted only when it has to be: the agent reads `@src/app.ts` fine, but a
  // path with a space would otherwise be split by whatever parses the line.
  const token = /\s/.test(path) ? `@"${path}"` : `@${path}`;
  return `${text.slice(0, mention.start)}${token} ${text.slice(mention.end)}`;
}
