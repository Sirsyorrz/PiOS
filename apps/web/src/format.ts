/** The directory name alone; callers show the full path elsewhere. */
/**
 * Keeps a string's own reading order inside a right-to-left box.
 *
 * Truncating a path from the front needs `direction: rtl`, which also moves a
 * trailing `/` to the head: "tmp/" renders as "/tmp". The isolate marks the
 * text as one left-to-right run without changing where the ellipsis lands.
 */
export function isolate(text: string): string {
  return `\u2066${text}\u2069`;
}

export function basename(path: string): string {
  return path.split("/").filter(Boolean).at(-1) ?? path;
}

/** Home prefix as `~`: the leading `/home/<user>` is noise on a phone. */
export function collapseHome(path: string): string {
  return path.replace(/^\/(?:home|Users)\/[^/]+/, "~");
}

export function shortenPath(path: string): string {
  const parts = path.split("/").filter(Boolean);
  return parts.length <= 2 ? path : `.../${parts.slice(-2).join("/")}`;
}

/** Today as a clock time, otherwise a day count: precision decays with age. */
export function relativeTime(at: number): string {
  const days = Math.floor((Date.now() - at) / 86_400_000);
  if (days === 0)
    return new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  if (days === 1) return "yesterday";
  return `${days}d ago`;
}
