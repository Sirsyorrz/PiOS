/**
 * Persistence, abstracted.
 *
 * localStorage on web, MMKV on React Native, a file in tests. Synchronous
 * writes on purpose: the outbox must be durable before `send` returns, and an
 * async write that loses a race with app termination loses the user's prompt.
 */
export interface StorageAdapter {
  get(key: string): string | null;
  set(key: string, value: string): void;
  remove(key: string): void;
}

export class MemoryStorage implements StorageAdapter {
  private readonly map = new Map<string, string>();

  get(key: string): string | null {
    return this.map.get(key) ?? null;
  }
  set(key: string, value: string): void {
    this.map.set(key, value);
  }
  remove(key: string): void {
    this.map.delete(key);
  }
  /** Survives a simulated restart, unlike the object holding it. */
  clone(): MemoryStorage {
    const copy = new MemoryStorage();
    for (const [key, value] of this.map) copy.set(key, value);
    return copy;
  }
}

export interface VersionedDocument<T> {
  version: number;
  data: T;
}

export type Migration<T> = (data: unknown, fromVersion: number) => T;

/**
 * Reads a versioned document, migrating or discarding older ones.
 *
 * Discarding is a real option for caches, but never for the outbox: dropping
 * a queued prompt silently is the one failure the user cannot recover from.
 */
export function readVersioned<T>(
  storage: StorageAdapter,
  key: string,
  version: number,
  fallback: T,
  migrate?: Migration<T>,
): T {
  const raw = storage.get(key);
  if (!raw) return fallback;
  try {
    const parsed = JSON.parse(raw) as VersionedDocument<unknown>;
    if (parsed.version === version) return parsed.data as T;
    if (migrate) return migrate(parsed.data, parsed.version);
    return fallback;
  } catch {
    return fallback;
  }
}

export function writeVersioned<T>(
  storage: StorageAdapter,
  key: string,
  version: number,
  data: T,
): void {
  storage.set(key, JSON.stringify({ version, data } satisfies VersionedDocument<T>));
}
