import type { StorageAdapter } from "@pios/client-core";

/**
 * localStorage, not IndexedDB: the outbox needs a synchronous write that has
 * landed before the tab can be killed, and IndexedDB cannot promise that.
 */
export const browserStorage: StorageAdapter = {
  get: (key) => {
    try {
      return window.localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  set: (key, value) => {
    try {
      window.localStorage.setItem(key, value);
    } catch {
      // Private mode or a full quota. Losing durability is bad; taking the
      // app down with an exception on every keystroke is worse.
    }
  },
  remove: (key) => {
    try {
      window.localStorage.removeItem(key);
    } catch {
      /* see above */
    }
  },
};
