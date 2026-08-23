import type { SessionEntry } from "@pios/protocol";
import type { EntriesPage } from "./types.ts";

/**
 * Slices a full entry list at a cursor.
 *
 * The in-process host has no `since` parameter: `sessionManager.getEntries()`
 * returns everything, so the cursor is applied here. An unrecognised cursor
 * becomes a reset page rather than an error, because the only correct client
 * response is to drop its cache and take the whole session.
 */
export function sliceEntriesSince(
  entries: SessionEntry[],
  leafId: string | null,
  since?: string,
): EntriesPage {
  if (since === undefined) return { entries, leafId, reset: false };

  const index = entries.findIndex((entry) => entry.id === since);
  if (index === -1) return { entries, leafId, reset: true };
  return { entries: entries.slice(index + 1), leafId, reset: false };
}
