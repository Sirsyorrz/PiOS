import { resolve, join } from "node:path";

/**
 * pi's `--session-dir` names one project's directory, not the root above them.
 * Passing the root makes sessions land flat next to the per-project folders,
 * where pi's own `/resume` never looks. Mirrors pi's encoding so one project
 * maps to exactly one directory.
 */
export function projectSessionDir(cwd: string, root: string): string {
  return join(root, sessionDirName(cwd));
}

/** The directory name pi derives from a project cwd. */
export function sessionDirName(cwd: string): string {
  return `--${resolve(cwd).replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
}
