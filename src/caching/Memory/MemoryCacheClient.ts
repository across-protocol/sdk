import { CachingMechanismInterface } from "../../interfaces";

interface CacheEntry {
  value: unknown;
  expiresAt?: number | null;
}

/**
 * A simple in-memory cache client that stores values in a map with TTL support.
 */
export class MemoryCacheClient implements CachingMechanismInterface {
  private cache: Map<string, CacheEntry> = new Map();

  get<T>(key: string): Promise<T | null> {
    return new Promise((resolve) => {
      const entry = this.cache.get(key);
      if (entry === undefined) return resolve(null);

      if (entry.expiresAt && entry.expiresAt < Date.now()) {
        this.cache.delete(key);
        return resolve(null);
      }

      resolve(entry.value as T);
    });
  }

  set<T>(key: string, value: T, ttl?: number): Promise<string | undefined> {
    return new Promise((resolve) => {
      const expiresAt = ttl ? Date.now() + ttl * 1000 : null;
      this.cache.set(key, { value, expiresAt });
      resolve(key);
    });
  }
}
