import { watch, type FSWatcher } from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";

/**
 * Watches pi's session store and nudges when it changes.
 *
 * The TUI and the daemon write to the same directory, so a session started or
 * advanced elsewhere has to show up here without anyone asking. Recursive
 * watching is not available on Linux, so the root and each project directory
 * are watched separately, and new project directories are picked up as the
 * root itself changes.
 */

const DEBOUNCE_MS = 500;

export class SessionStoreWatcher {
  private readonly root: string;
  private readonly onChange: (files: string[]) => void;
  private readonly watchers = new Map<string, FSWatcher>();
  /** Files written since the last nudge. */
  private readonly changed = new Set<string>();
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;

  constructor(root: string, onChange: (files: string[]) => void) {
    this.root = root;
    this.onChange = onChange;
  }

  async start(): Promise<void> {
    this.watchDir(this.root);
    await this.watchProjects();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    for (const watcher of this.watchers.values()) watcher.close();
    this.watchers.clear();
  }

  private watchDir(dir: string): void {
    if (this.stopped || this.watchers.has(dir)) return;
    try {
      const watcher = watch(dir, (_event, name) => this.fire(dir, name ? join(dir, String(name)) : null));
      watcher.on("error", () => {
        watcher.close();
        this.watchers.delete(dir);
      });
      watcher.unref?.();
      this.watchers.set(dir, watcher);
    } catch {
      // A directory that cannot be watched is not fatal: the list is still
      // correct whenever it is asked for, just not pushed.
    }
  }

  private async watchProjects(): Promise<void> {
    let entries;
    try {
      entries = await readdir(this.root, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory() || entry.isSymbolicLink()) this.watchDir(join(this.root, entry.name));
    }
  }

  /** Coalesces a burst of writes into one nudge. */
  private fire(dir: string, file: string | null): void {
    if (this.stopped) return;
    if (file?.endsWith(".jsonl")) this.changed.add(file);
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      // A change at the root can be a project directory that did not exist
      // when the watchers were set up.
      if (dir === this.root) void this.watchProjects();
      const files = [...this.changed];
      this.changed.clear();
      this.onChange(files);
    }, DEBOUNCE_MS);
    this.timer.unref?.();
  }
}
