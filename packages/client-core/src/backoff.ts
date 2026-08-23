/**
 * Exponential ladder, capped and infinite.
 *
 * Capped at 16s because a phone that has been in a tunnel for an hour should
 * reconnect within seconds of coming back, not after a 10-minute delay. Never
 * gives up: the daemon owning the session is the thing worth reaching, and a
 * client that stopped trying is indistinguishable from a broken one.
 */
export interface BackoffOptions {
  baseMs?: number;
  capMs?: number;
  factor?: number;
  /** Fraction of the delay that is randomised, to avoid a thundering herd. */
  jitter?: number;
  random?: () => number;
}

export const BACKOFF_CAP_MS = 16_000;

export class Backoff {
  private attempt = 0;
  private readonly baseMs: number;
  private readonly capMs: number;
  private readonly factor: number;
  private readonly jitter: number;
  private readonly random: () => number;

  constructor(options: BackoffOptions = {}) {
    this.baseMs = options.baseMs ?? 500;
    this.capMs = options.capMs ?? BACKOFF_CAP_MS;
    this.factor = options.factor ?? 2;
    this.jitter = options.jitter ?? 0;
    this.random = options.random ?? Math.random;
  }

  get attempts(): number {
    return this.attempt;
  }

  /** Delay for the next attempt, and advances the ladder. */
  next(): number {
    const raw = this.baseMs * this.factor ** this.attempt;
    this.attempt++;
    const capped = Math.min(raw, this.capMs);
    if (this.jitter === 0) return capped;
    const spread = capped * this.jitter;
    return Math.round(capped - spread + this.random() * spread * 2);
  }

  reset(): void {
    this.attempt = 0;
  }
}
