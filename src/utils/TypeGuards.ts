export function isPromiseFulfilled<T>(
  promiseSettledResult: PromiseSettledResult<T>
): promiseSettledResult is PromiseFulfilledResult<T> {
  return promiseSettledResult.status === "fulfilled";
}

export function isPromiseRejected<T>(
  promiseSettledResult: PromiseSettledResult<T>
): promiseSettledResult is PromiseRejectedResult {
  return promiseSettledResult.status === "rejected";
}

export function isDefined<T>(input: T | null | undefined): input is T {
  return input !== null && input !== undefined;
}

export function isValidType(input: object, expectedTypeProps: string[]): boolean {
  for (const prop of expectedTypeProps) {
    if (!(prop in input)) {
      return false;
    }
  }
  return true;
}