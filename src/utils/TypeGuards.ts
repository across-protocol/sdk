import { SVMProvider } from "../arch/svm/types";
import { EvmProvider } from "../arch/evm/types";
import { TronWeb } from "tronweb";
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

export function isTvmProvider(provider: EvmProvider | SVMProvider | TronWeb): provider is TronWeb {
  return isDefined((provider as TronWeb).transactionBuilder);
}

export function isEvmProvider(provider: EvmProvider | SVMProvider | TronWeb): provider is EvmProvider {
  return provider instanceof providers.Provider;
}
