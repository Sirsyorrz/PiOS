/** A set of callbacks, notified in the order they were added. */
export class Listeners<Args extends unknown[]> {
  private readonly handlers = new Set<(...args: Args) => void>();

  /** Returns the matching unsubscribe. */
  add(handler: (...args: Args) => void): () => void {
    this.handlers.add(handler);
    return () => {
      this.handlers.delete(handler);
    };
  }

  /** Iterates a copy, so a handler may unsubscribe itself mid-emit. */
  emit(...args: Args): void {
    for (const handler of [...this.handlers]) handler(...args);
  }
}
