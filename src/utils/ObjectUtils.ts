/* eslint-disable @typescript-eslint/explicit-module-boundary-types */
/* eslint-disable @typescript-eslint/no-explicit-any */
// Append value along the keyPath to object. For example assign(deposits, ['1337', '31337'], [{depositId:1}]) will create
// deposits = {1337:{31337:[{depositId:1}]}}. Note that if the path into the object exists then this will append. This

// -----------------------------------------------------------------------------
// Overload declarations (must appear before the implementation).
// -----------------------------------------------------------------------------
export function assign<T, K1 extends keyof T>(obj: T, keyPath: [K1], value: T[K1]): void;
export function assign<T, K1 extends keyof T, K2 extends keyof NonNullable<T[K1]>>(
  obj: T,
  keyPath: [K1, K2],
  value: NonNullable<T[K1]>[K2]
): void;
export function assign<
  T,
  K1 extends keyof T,
  K2 extends keyof NonNullable<T[K1]>,
  K3 extends keyof NonNullable<NonNullable<T[K1]>[K2]>,
>(obj: T, keyPath: [K1, K2, K3], value: NonNullable<NonNullable<T[K1]>[K2]>[K3]): void;

// function respects the destination type; if it is an object then deep merge and if an array effectively will push.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function assign(obj: any, keyPath: any[], value: any): void {
  const lastKeyIndex = keyPath.length - 1;
  for (let i = 0; i < lastKeyIndex; ++i) {
    const key = keyPath[i];
    if (!(key in obj)) {
      obj[key] = {};
    }
    obj = obj[key];
  }
  // If the object at the deep path does not exist then set to the value.
  if (!obj[keyPath[lastKeyIndex]] || typeof obj[keyPath[lastKeyIndex]] == "string") {
    obj[keyPath[lastKeyIndex]] = value;
  }
  // If the object at the deep path is an array then append array wise.
  else if (Array.isArray(value)) {
    obj[keyPath[lastKeyIndex]] = [...obj[keyPath[lastKeyIndex]], ...value];
  }
  // If the value is false bool then set to false. This special case is needed as {...false} = {} which causes issues.
  else if (value === false) {
    obj[keyPath[lastKeyIndex]] = false;
  }
  // If the object at the deep path is an object then append object wise.
  else {
    obj[keyPath[lastKeyIndex]] = { ...obj[keyPath[lastKeyIndex]], ...value };
  }
}

// Trims `obj` by deleting `value` and all empty dictionaries produced from that deletion.
export function deleteFromJson(obj: Record<string | number, unknown>, keyPath: (string | number)[]): void {
  const lastKeyIndex = keyPath.length - 1;
  let _obj = obj; // Copy the pointer.
  for (let i = 0; i < lastKeyIndex; ++i) {
    const key = keyPath[i];
    _obj = obj[key] as Record<string | number, unknown>;
  }
  delete _obj[keyPath[lastKeyIndex]];
  if (lastKeyIndex !== 0 && Object.values(_obj).length === 0) {
    deleteFromJson(obj, keyPath.slice(0, lastKeyIndex));
  }
}

// Refactor to be more generalized with N props
export function groupObjectCountsByThreeProps(
  objects: any[],
  primaryProp: string,
  secondaryProp: string,
  tertiaryProp: string
): any {
  return objects.reduce((result, obj) => {
    result[obj[primaryProp]] = result[obj[primaryProp]] ?? {};
    result[obj[primaryProp]][obj[secondaryProp]] = result[obj[primaryProp]][obj[secondaryProp]] ?? {};
    const existingCount = result[obj[primaryProp]][obj[secondaryProp]][obj[tertiaryProp]];
    result[obj[primaryProp]][obj[secondaryProp]][obj[tertiaryProp]] =
      existingCount === undefined ? 1 : existingCount + 1;
    return result;
  }, {});
}
export function groupObjectCountsByTwoProps(
  objects: any[],
  primaryProp: string,
  getSecondaryProp: (obj: any) => string
): any {
  return objects.reduce((result, obj) => {
    result[obj[primaryProp]] = result[obj[primaryProp]] ?? {};
    const existingCount = result[obj[primaryProp]][getSecondaryProp(obj)];
    result[obj[primaryProp]][getSecondaryProp(obj)] = existingCount === undefined ? 1 : existingCount + 1;
    return result;
  }, {});
}

export function groupObjectCountsByProp(objects: any[], getProp: (obj: any) => string): any {
  return objects.reduce((result, obj) => {
    const existingCount = result[getProp(obj)];
    result[getProp(obj)] = existingCount === undefined ? 1 : existingCount + 1;
    return result;
  }, {});
}

/**
 * Filter out falsy keys from an object. Falsy keys are keys with values of false, null, undefined, 0, or empty string.
 * @param obj The object to filter
 * @returns A new object with falsy keys removed
 */
export function filterFalsyKeys(obj: Record<string | number, unknown>): Record<string | number, unknown> {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v));
}

export function count2DDictionaryValues(dictionary: { [key: string]: { [key2: string]: any[] } }): {
  [key: string]: { [key2: string]: number };
} {
  return Object.entries(dictionary).reduce((output, [key, innerDict]) => {
    const innerDictOutput = Object.entries(innerDict).reduce((innerOutput, [key2, vals]) => {
      return { ...innerOutput, [key2]: vals.length };
    }, {});
    return { ...output, [key]: innerDictOutput };
  }, {});
}

export function count3DDictionaryValues(
  dictionary: { [key: string]: { [key2: string]: any } },
  innerPropName: string
): { [key: string]: { [key2: string]: number } } {
  return Object.entries(dictionary).reduce((output, [key, innerDict]) => {
    const innerDictOutput = Object.entries(innerDict).reduce((innerOutput, [key2, vals]) => {
      return { ...innerOutput, [key2]: vals[innerPropName].length };
    }, {});
    return { ...output, [key]: innerDictOutput };
  }, {});
}
