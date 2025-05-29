import { SVMProvider } from "../arch/svm/types";
import { EvmProvider } from "../arch/evm/types";
import { providers } from "ethers";

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

export function isEvmProvider(provider: EvmProvider | SVMProvider): provider is EvmProvider {
  // Check that the provider doesn't have SVM-specific methods
  return typeof provider === "object" && provider !== null && !("getSlot" in provider);
}
