import { SVMProvider } from "../arch/svm/types";
import { EvmProvider } from "../arch/evm/types";

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
  // Check for EVM-specific methods that should exist on all ethers.js providers
  return (
    provider !== null &&
    typeof provider === "object" &&
    "getNetwork" in provider &&
    "getBlock" in provider &&
    "getCode" in provider
  );
}
