/**
 * Deduplicates an array by filtering it via a Set.
 * @notice Should not be used for deduplicating arrays of complex types.
 * @param array The array to deduplicate.
 * @returns A new array, filtered for uniqueness.
 */
export function dedupArray<T>(array: T[]): T[] {
  return Array.from(new Set(array));
}

/**
 * Returns the last index of an array that matches the given predicate.
 * @note Emulates Array.prototype.findLastIndex
 * @param array The array to search.
 * @param predicate The predicate function to apply to each element.
 * @returns The last index of the array that matches the predicate, or -1 if no element matches.
 */
export function findLastIndex<T>(array: T[], predicate: (value: T, index: number, obj: T[]) => boolean): number {
  for (let i = array.length - 1; i >= 0; i--) {
    if (predicate(array[i], i, array)) {
      return i;
    }
  }
  return -1;
}

/**
 * Returns the last element of an array that matches the given predicate.
 * @note Emulates Array.prototype.findLast
 * @param array The array to search.
 * @param predicate The predicate function to apply to each element.
 * @returns The last element of the array that matches the predicate, or undefined if no element matches.
 */
export function findLast<T>(array: T[], predicate: (value: T, index: number, obj: T[]) => boolean): T | undefined {
  const index = findLastIndex(array, predicate);
  return index >= 0 ? array[index] : undefined;
}

/**
 * Performs an asynchronous filter operation on an array. This function behaves like Array.prototype.filter, but
 * accepts an asynchronous predicate function.
 * @param array The array to filter.
 * @param predicate The asynchronous predicate function to apply to each element.
 * @returns A promise that resolves to an array of elements that match the predicate.
 */
export async function filterAsync<T>(
  array: T[],
  predicate: (value: T, index: number, obj: T[]) => Promise<boolean>
): Promise<T[]> {
  const results = await Promise.all(array.map(predicate));
  return array.filter((_, index) => results[index]);
}

/**
 * Performs an asynchronous map operation on an array. This function behaves like Array.prototype.map, but accepts an
 * asynchronous mapper function.
 * @param array The array to map.
 * @param mapper The asynchronous mapper function to apply to each element.
 * @returns A promise that resolves to an array of mapped elements.
 */
export function mapAsync<T, U>(array: T[], mapper: (value: T, index: number, obj: T[]) => Promise<U>): Promise<U[]> {
  return Promise.all(array.map(mapper));
}

/**
 * Performs an asynchronous reduce operation on an array. This function behaves like Array.prototype.reduce, but
 * accepts an asynchronous reducer function.
 * @param array The array to reduce.
 * @param reducer The asynchronous reducer function to apply to each element.
 * @param initialValue The initial value of the accumulator.
 * @returns A promise that resolves to the final value of the accumulator.
 */
export async function reduceAsync<T, U>(
  array: T[],
  reducer: (accumulator: U, currentValue: T, currentIndex: number, obj: T[]) => Promise<U>,
  initialValue: U
): Promise<U> {
  let accumulator = initialValue;
  for (let i = 0; i < array.length; i++) {
    accumulator = await reducer(accumulator, array[i], i, array);
  }
  return accumulator;
}

/**
 * Performs an asynchronous forEach operation on an array. This function behaves like Array.prototype.forEach, but
 * accepts an asynchronous callback function.
 * @param array The array to iterate over.
 * @param callback The asynchronous callback function to apply to each element.
 * @returns A promise that resolves to void.
 */
export async function forEachAsync<T>(
  array: T[],
  callback: (value: T, index: number, obj: T[]) => Promise<void>
): Promise<void> {
  await mapAsync(array, callback);
}

/**
 * Performs an asynchronous some operation on an array. This function behaves like Array.prototype.some, but accepts
 * an asynchronous predicate function.
 * @param array The array to search.
 * @param predicate The asynchronous predicate function to apply to each element.
 * @returns A promise that resolves to true if any element matches the predicate, or false if no element matches.
 */
export async function someAsync<T>(
  array: T[],
  predicate: (value: T, index: number, obj: T[]) => Promise<boolean>
): Promise<boolean> {
  const results = await mapAsync(array, predicate);
  return results.some((value) => value);
}

/**
 * Performs an asynchronous every operation on an array. This function behaves like Array.prototype.every, but accepts
 * an asynchronous predicate function.
 * @param array The array to test.
 * @param predicate The asynchronous predicate function to apply to each element.
 * @returns A promise that resolves to true if all elements match the predicate, or false if any element does not match.
 * @note This function uses De Morgan's law to convert the predicate to a negated predicate, and then uses someAsync.
 *       This is done because it is more efficient to short-circuit on the first false value than the first true value.
 */
export async function everyAsync<T>(
  array: T[],
  predicate: (value: T, index: number, obj: T[]) => Promise<boolean>
): Promise<boolean> {
  return !(await someAsync(array, async (value, index, obj) => !(await predicate(value, index, obj))));
}

/**
 * Performs an asynchronous includes operation on an array. This function behaves like Array.prototype.includes, but
 * accepts an asynchronous predicate function.
 * @param array The array to search.
 * @param predicate The asynchronous predicate function to apply to each element.
 * @returns A promise that resolves to true if any element matches the predicate, or false if no element matches.
 * @note This function uses someAsync.
 */
export function includesAsync<T>(
  array: T[],
  predicate: (value: T, index: number, obj: T[]) => Promise<boolean>
): Promise<boolean> {
  return someAsync(array, predicate);
}

/**
 * A generic type guard for arrays of a specific type.
 * @param array The array to test.
 * @param predicate The type guard predicate function to apply to each element.
 * @returns True if the array is an array of the specified type, or false otherwise.
 * @note This function uses Array.prototype.every.
 */
export function isArrayOf<T>(array: unknown, predicate: (value: unknown) => value is T): array is T[] {
  return Array.isArray(array) && array.every(predicate);
}
