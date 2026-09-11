import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { ProjectTrustStore } from "@earendil-works/pi-coding-agent";

/**
 * Which project directories may load their own extensions, settings and
 * packages.
 *
 * pi's own store, not a second one: the TUI and this daemon run the same
 * projects, and a directory the user already trusted there must not be asked
 * about again here.
 *
 * Trust belongs to a directory, not to a conversation. A session is started
 * lazily and restarted whenever it is woken, so asking per session would ask
 * the same question forever.
 */
export class TrustStore {
  private readonly store: ProjectTrustStore;

  constructor(agentDir: string) {
    this.store = new ProjectTrustStore(agentDir);
  }

  /**
   * Trust for a directory, inherited from the nearest answered ancestor.
   *
   * pi records a decision for the path the user answered about, which may be a
   * parent of the project; walking up is what makes one answer cover the
   * repositories underneath it.
   */
  isTrusted(cwd: string): boolean {
    let path = resolve(cwd);
    const stop = resolve(homedir(), "..");
    for (;;) {
      const decision = this.store.get(path);
      if (decision !== null) return decision;
      const parent = dirname(path);
      if (parent === path || path === stop) return false;
      path = parent;
    }
  }

  set(cwd: string, trusted: boolean): void {
    this.store.set(resolve(cwd), trusted);
  }
}
