import { Struct } from "superstruct";

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
  get<ObjectType, OverrideType = unknown>(
    key?: string,
    structValidator?: Struct<unknown, unknown>,
    overrides?: OverrideType
  ): Promise<ObjectType | null>;

  /**
   * Attempts to set a key in the caching store. Returns the ID of the value stored. This is useful for storing values
   * in a cache that are not known ahead of time. For example, if you want to store a value in a cache that is the result of a
   * computation, you can use this method to store the value and retrieve the ID of the value stored.
   * @param key The canonical key to store.
   * @param value The value to store.
   * @param ttl The time to live in seconds.
   * @param overrides Any overrides to the default caching mechanism configuration for the given caching protocol.
   * @note Caching mechanisms where the `key` is directly used to store values will return `key` on success.
   * @returns The ID of the value stored. If the value could not be stored, undefined is returned. If the caching mechanism uses the `key` as the ID, the `key` is returned.
   */
  set<ObjectType, OverrideType>(
    key: string,
    value: ObjectType,
    ttl?: number,
    overrides?: OverrideType
  ): Promise<string | undefined>;

  /**
   * Subscribes to a topic.
   * @param topic The topic to subscribe to.
   * @param callback The callback to call when a message is received.
   */
  sub(topic: string, callback: (message: string, channel: string) => unknown): Promise<number>;

  /**
   * Publishes a message to the network.
   * @param topic The topic to publish to.
   * @param message The message to publish.
   */
  pub(topic: string, message: string): Promise<number>;
}
