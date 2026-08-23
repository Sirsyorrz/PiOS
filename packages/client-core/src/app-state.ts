import { systemScheduler, type Scheduler } from "./scheduler.ts";

export type AppState = "active" | "inactive" | "background";

/**
 * Ten seconds. Under it, the socket has probably survived and a probe is
 * enough. Over it, the OS may have killed the socket underneath an attempt
 * that still looks in flight, so the connection is replaced outright.
 */
export const BACKGROUND_RECONNECT_AFTER_MS = 10_000;

export interface AppStatePolicyTarget {
  wake(reason: string): void;
  probe(): void;
}

/**
 * Translates platform lifecycle events into supervisor commands.
 *
 * Kept apart from the supervisor because the lifecycle model differs per
 * platform, while the rule does not.
 */
export class AppStatePolicy {
  private readonly target: AppStatePolicyTarget;
  private readonly scheduler: Scheduler;
  private readonly thresholdMs: number;
  private backgroundedAt: number | null = null;
  private state: AppState = "active";

  constructor(
    target: AppStatePolicyTarget,
    options: { scheduler?: Scheduler; thresholdMs?: number } = {},
  ) {
    this.target = target;
    this.scheduler = options.scheduler ?? systemScheduler;
    this.thresholdMs = options.thresholdMs ?? BACKGROUND_RECONNECT_AFTER_MS;
  }

  get appState(): AppState {
    return this.state;
  }

  set(next: AppState): void {
    const previous = this.state;
    this.state = next;

    if (next === "background") {
      this.backgroundedAt = this.scheduler.now();
      return;
    }
    if (next !== "active" || previous === "active") return;

    const away = this.backgroundedAt === null ? 0 : this.scheduler.now() - this.backgroundedAt;
    this.backgroundedAt = null;
    if (away >= this.thresholdMs) {
      this.target.wake("application-active-reconnect");
    } else {
      this.target.probe();
    }
  }
}
