/**
 * The interface for a caching mechanism. This is used to store and retrieve values from a cache.
 * @interface CachingInterface
 * @exports
 */
export interface CachingMechanismInterface {
  /**
   * Attempts to retrieve a value from the cache.
   * @param key The key to retrieve.
   * @returns The value if it exists, otherwise null.
   */
  get<T>(key: string): Promise<T | null>;

  /**
   * Attempts to store a value in the cache.
   * @param key The key to store.
   * @param value The value to store.
   * @param ttl The time to live in seconds.
   * @param overrides Any overrides to the default caching mechanism configuration for the given caching protocol.
   * @returns True if the value was stored, otherwise false.
   * @throws {Error} If the value could not be stored.
   */
  set<T>(key: string, value: T, ttl?: number, overrides?: unknown): Promise<boolean>;
}
