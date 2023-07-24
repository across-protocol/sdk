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

// #################################################################################################
// ########################## Examples of usage of this interface ##################################
// #################################################################################################

// EXAMPLE 1: Using the interface to create a file-based caching mechanism.

// import { CachingMechanismInterface } from "../interfaces";
// import fs from "fs";

// /**
//  * A simple file-based cache store. This serves as both a reference implementation and an optional fallback if no other caching mechanism is available.
//  * @class FileCacheStore
//  * @implements {CachingMechanismInterface}
//  * @exports FileCacheStore
//  */
// export class FileCacheStore implements CachingMechanismInterface {
//   private readonly filePath: string;

//   public constructor(filePath: string) {
//     // Verify that the file is writable
//     if (!this.ensureFileIsWritable()) {
//       throw new Error(`File ${filePath} is not writable.`);
//     }
//     // Set the file path
//     this.filePath = filePath;
//   }

//   /**
//    * An internal method to ensure that the file is writable.
//    * @returns True if the file is writable, otherwise false.
//    */
//   private ensureFileIsWritable(): boolean {
//     try {
//       // Check if the file exists and is writable
//       fs.accessSync(this.filePath, fs.constants.W_OK);
//       return true;
//     } catch (err) {
//       return false;
//     }
//   }

//   async get<T>(key: string): Promise<T | null> {
//     try {
//       // Read the file contents
//       const fileContents = await fs.promises.readFile(this.filePath, "utf-8");
//       // Parse the JSON object
//       const cacheObject = JSON.parse(fileContents);
//       // Check if the key exists in the cache object
//       if (cacheObject[key]) {
//         // Get the value and ttl for the given key
//         const { value, ttl } = cacheObject[key];
//         // Check if the ttl has expired
//         if (ttl && Date.now() > ttl) {
//           // If the ttl has expired, delete the key and return null
//           delete cacheObject[key];
//           await fs.promises.writeFile(this.filePath, JSON.stringify(cacheObject));
//           return null;
//         }
//         // Return the value for the given key
//         return value;
//       }
//       // If the key does not exist in the cache object, return null
//       return null;
//     } catch (err) {
//       // If there was an error reading the file or parsing the JSON object, return null
//       return null;
//     }
//   }

//   async set<T>(key: string, value: T, ttl?: number | undefined): Promise<boolean> {
//     // Create the cache object
//     const cacheObject: { [key: string]: { value: unknown; ttl?: number } } = {};
//     // Check if the file exists
//     if (this.ensureFileIsWritable()) {
//       // Read the file contents
//       const fileContents = await fs.promises.readFile(this.filePath, "utf-8");
//       // Parse the JSON object
//       const existingCacheObject = JSON.parse(fileContents);
//       // Merge the existing cache object with the new key-value pair
//       Object.assign(cacheObject, existingCacheObject, { [key]: { value, ttl } });
//     } else {
//       // If the file does not exist, create the cache object with the new key-value pair
//       Object.assign(cacheObject, { [key]: { value, ttl } });
//     }
//     // Write the cache object to the file
//     await fs.promises.writeFile(this.filePath, JSON.stringify(cacheObject));
//     // Return true
//     return Promise.resolve(true);
//   }
// }

// #################################################################################################
// #################################################################################################
// Example 2: Using the interface to create an in-memory caching mechanism.

// import { CachingMechanismInterface } from "../interfaces";

// /**
//  * A simple in-memory cache store. This serves as both a reference implementation and a fallback if no other caching mechanism is available.
//  * @class MemoryCacheStore
//  * @implements {CachingMechanismInterface}
//  * @exports
//  */
// export class MemoryCacheStore implements CachingMechanismInterface {
//   /**
//    * The cache.
//    */
//   private cache: Map<string, { value: unknown; expiresAt: number }> = new Map();

//   async get<T>(key: string): Promise<T | null> {
//     const cachedValue = this.cache.get(key);
//     if (!cachedValue) {
//       return null;
//     }
//     if (cachedValue.expiresAt < Date.now()) {
//       this.cache.delete(key);
//       return null;
//     }
//     return cachedValue.value as T;
//   }

//   async set<T>(key: string, value: T, ttl?: number | undefined): Promise<boolean> {
//     const expiresAt = ttl ? Date.now() + ttl : Number.MAX_SAFE_INTEGER;
//     this.cache.set(key, { value, expiresAt });
//     return true;
//   }
// }
