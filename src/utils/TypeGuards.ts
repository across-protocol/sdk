import { providers } from "ethers";
import { SVMProvider } from "../arch/svm/types";

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

export function isEvmProvider(provider: providers.Provider | SVMProvider): provider is providers.Provider {
  return provider instanceof providers.Provider;
}
