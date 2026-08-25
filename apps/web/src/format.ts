/** The directory name alone; callers show the full path elsewhere. */
export function basename(path: string): string {
  return path.split("/").filter(Boolean).at(-1) ?? path;
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
