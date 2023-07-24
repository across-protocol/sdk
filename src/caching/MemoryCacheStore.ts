import { CachingMechanismInterface } from "../interfaces";

/**
 * A simple in-memory cache store. This serves as both a reference implementation and a fallback if no other caching mechanism is available.
 * @class MemoryCacheStore
 * @implements {CachingMechanismInterface}
 * @exports
 */
export class MemoryCacheStore implements CachingMechanismInterface {
  /**
   * The cache.
   */
  private cache: Map<string, { value: unknown; expiresAt: number }> = new Map();

  async get<T>(key: string): Promise<T | null> {
    const cachedValue = this.cache.get(key);
    if (!cachedValue) {
      return null;
    }
    if (cachedValue.expiresAt < Date.now()) {
      this.cache.delete(key);
      return null;
    }
    return cachedValue.value as T;
  }

  async set<T>(key: string, value: T, ttl?: number | undefined): Promise<boolean> {
    const expiresAt = ttl ? Date.now() + ttl : Number.MAX_SAFE_INTEGER;
    this.cache.set(key, { value, expiresAt });
    return true;
  }
}
