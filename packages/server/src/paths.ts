import { realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";

/**
 * Containment check for file serving.
 *
 * The daemon serves files on behalf of an agent that can create symlinks, so
 * lexical containment is not enough: the real path is resolved and checked
 * against the real root. A path that does not exist yet is checked lexically
 * against the resolved root, which is the correct behaviour for uploads.
 */
export function containedPath(root: string, candidate: string): string | null {
  const realRoot = tryRealpath(resolve(root));
  const absolute = isAbsolute(candidate) ? candidate : resolve(realRoot, candidate);
  const real = tryRealpath(absolute);

  const rel = relative(realRoot, real);
  if (rel === "") return real;
  if (isAbsolute(rel)) return null;
  // Segment-aware, not a string prefix: a file legitimately named "..notes"
  // is inside the root, while "../notes" is not.
  if (rel === ".." || rel.startsWith(`..${sep}`)) return null;
  return real;
}

function tryRealpath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}
