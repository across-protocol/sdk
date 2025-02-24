import { ethers } from "ethers";
import { CachingMechanismInterface } from "../interfaces";
import { CHAIN_IDs } from "../constants";
import { delay, isDefined, isPromiseFulfilled, isPromiseRejected } from "../utils";
import { getOriginFromURL } from "../utils/NetworkUtils";
import { CacheProvider } from "./cachedProvider";
import { compareRpcResults, createSendErrorWithMessage, formatProviderError } from "./utils";
import { PROVIDER_CACHE_TTL } from "./constants";
import { JsonRpcError, RpcError } from "./types";
import { Logger } from "winston";

export class RetryProvider extends ethers.providers.StaticJsonRpcProvider {
  readonly providers: ethers.providers.StaticJsonRpcProvider[];
  constructor(
    params: ConstructorParameters<typeof ethers.providers.StaticJsonRpcProvider>[],
    chainId: number,
    readonly nodeQuorumThreshold: number,
    readonly retries: number,
    readonly delay: number,
    readonly maxConcurrency: number,
    providerCacheNamespace: string,
    pctRpcCallsLogged: number,
    redisClient?: CachingMechanismInterface,
    standardTtlBlockDistance?: number,
    noTtlBlockDistance?: number,
    providerCacheTtl = PROVIDER_CACHE_TTL,
    readonly logger?: Logger
  ) {
    // Initialize the super just with the chainId, which stops it from trying to immediately send out a .send before
    // this derived class is initialized.
    super(undefined, chainId);
    this.providers = params.map(
      (inputs) =>
        new CacheProvider(
          providerCacheNamespace,
          redisClient,
          standardTtlBlockDistance,
          noTtlBlockDistance,
          providerCacheTtl,
          maxConcurrency,
          pctRpcCallsLogged,
          logger,
          ...inputs
        )
    );

    if (chainId !== CHAIN_IDs.MAINNET) {
      this.pollingInterval = 1000;
      this.providers.forEach((provider) => (provider.pollingInterval = this.pollingInterval));
    }

    if (this.nodeQuorumThreshold < 1 || !Number.isInteger(this.nodeQuorumThreshold)) {
      throw new Error(
        `nodeQuorum,Threshold cannot be < 1 and must be an integer. Currently set to ${this.nodeQuorumThreshold}`
      );
    }
    if (this.retries < 0 || !Number.isInteger(this.retries)) {
      throw new Error(`retries cannot be < 0 and must be an integer. Currently set to ${this.retries}`);
    }
    if (this.delay < 0) {
      throw new Error(`delay cannot be < 0. Currently set to ${this.delay}`);
    }
    if (this.nodeQuorumThreshold > this.providers.length) {
      throw new Error(
        `nodeQuorumThreshold (${this.nodeQuorumThreshold}) must be <= the number of providers (${this.providers.length})`
      );
    }
  }

  override async send(method: string, params: Array<unknown>): Promise<unknown> {
    const quorumThreshold = this._getQuorum(method, params);
    const requiredProviders = this.providers.slice(0, quorumThreshold);
    const fallbackProviders = this.providers.slice(quorumThreshold);
    const errors: [ethers.providers.StaticJsonRpcProvider, string][] = [];

    // This function is used to try to send with a provider and if it fails pop an element off the fallback list to try
    // with that one. Once the fallback provider list is empty, the method throws. Because the fallback providers are
    // removed, we ensure that no provider is used more than once because we care about quorum, making sure all
    // considered responses come from unique providers.
    const tryWithFallback = (
      provider: ethers.providers.StaticJsonRpcProvider
    ): Promise<[ethers.providers.StaticJsonRpcProvider, unknown]> => {
      return this._trySend(provider, method, params)
        .then((result): [ethers.providers.StaticJsonRpcProvider, unknown] => [provider, result])
        .catch((err: unknown) => {
          // Append the provider and error to the error array.
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          errors.push([provider, (err as any)?.stack || err?.toString()]);

          // If there are no new fallback providers to use, terminate the recursion by throwing an error.
          // Otherwise, we can try to call another provider.
          if (fallbackProviders.length === 0) {
            throw err;
          }

          // If one RPC provider reverted, others likely will too. Skip them.
          if (quorumThreshold === 1 && this.failImmediate(method, err)) {
            throw err;
          }

          // This line does two things:
          // 1. Removes a fallback provider from the array so it cannot be used as a fallback for another required
          // provider.
          // 2. Recursively calls this method with that provider so it goes through the same try logic as the previous one.
          return tryWithFallback(fallbackProviders.shift()!);
        });
    };

    const results = await Promise.allSettled(requiredProviders.map(tryWithFallback));

    if (!results.every(isPromiseFulfilled)) {
      // Format the error so that it's very clear which providers failed and succeeded.
      const errorTexts = errors.map(([provider, errorText]) => formatProviderError(provider, errorText));
      const successfulProviderUrls = results.filter(isPromiseFulfilled).map((result) => result.value[0].connection.url);
      throw createSendErrorWithMessage(
        `Not enough providers succeeded. Errors:\n${errorTexts.join("\n")}\n` +
          `Successful Providers:\n${successfulProviderUrls.join("\n")}`,
        results.find(isPromiseRejected)?.reason
      );
    }

    const values = results.map((result) => result.value);

    // Start at element 1 and begin comparing.
    // If _all_ values are equal, we have hit quorum, so return.
    if (values.slice(1).every(([, output]) => compareRpcResults(method, values[0][1], output))) {
      return values[0][1];
    }

    const getMismatchedProviders = (values: [ethers.providers.StaticJsonRpcProvider, unknown][]) => {
      return values
        .filter(([, result]) => !compareRpcResults(method, result, quorumResult))
        .map(([provider]) => provider.connection.url);
    };

    const logQuorumMismatchOrFailureDetails = (
      method: string,
      params: Array<unknown>,
      quorumProviders: string[],
      mismatchedProviders: string[],
      errors: [ethers.providers.StaticJsonRpcProvider, string][]
    ) => {
      this.logger?.warn({
        at: "ProviderUtils",
        message: "Some providers mismatched with the quorum result or failed 🚸",
        notificationPath: "across-warn",
        method,
        params: JSON.stringify(params),
        quorumProviders,
        mismatchedProviders,
        erroringProviders: errors.map(([provider, errorText]) => formatProviderError(provider, errorText)),
      });
    };

    const throwQuorumError = (fallbackValues?: [ethers.providers.StaticJsonRpcProvider, unknown][]) => {
      const errorTexts = errors.map(([provider, errorText]) => formatProviderError(provider, errorText));
      const successfulProviderUrls = values.map(([provider]) => provider.connection.url);
      const mismatchedProviders = getMismatchedProviders([...values, ...(fallbackValues || [])]);
      logQuorumMismatchOrFailureDetails(method, params, successfulProviderUrls, mismatchedProviders, errors);
      throw new Error(
        "Not enough providers agreed to meet quorum.\n" +
          "Providers that errored:\n" +
          `${errorTexts.join("\n")}\n` +
          "Providers that succeeded, but some failed to match:\n" +
          successfulProviderUrls.join("\n")
      );
    };

    // Exit early if there are no fallback providers left.
    if (fallbackProviders.length === 0) {
      throwQuorumError();
    }

    // Try each fallback provider in parallel.
    const fallbackResults = await Promise.allSettled(
      fallbackProviders.map((provider) =>
        this._trySend(provider, method, params)
          .then((result): [ethers.providers.StaticJsonRpcProvider, unknown] => [provider, result])
          .catch((err) => {
            errors.push([provider, err?.stack || err?.toString()]);
            throw new Error("No fallbacks during quorum search");
          })
      )
    );

    // This filters only the fallbacks that succeeded.
    const fallbackValues = fallbackResults.filter(isPromiseFulfilled).map((promise) => promise.value);

    // Group the results by the count of that result.
    const counts = [...values, ...fallbackValues].reduce(
      (acc, curr) => {
        const [, result] = curr;

        // Find the first result that matches the return value.
        const existingMatch = acc.find(([existingResult]) => compareRpcResults(method, existingResult, result));

        // Increment the count if a match is found, else add a new element to the match array with a count of 1.
        if (existingMatch) {
          existingMatch[1]++;
        } else {
          acc.push([result, 1]);
        }

        // Return the same acc object because it was modified in place.
        return acc;
      },
      [[undefined, 0]] as [unknown, number][] // Initialize with [undefined, 0] as the first element so something is always returned.
    );

    // Sort so the result with the highest count is first.
    counts.sort(([, a], [, b]) => b - a);

    // Extract the result by grabbing the first element.
    const [quorumResult, count] = counts[0];

    // If this count is less than we need for quorum, throw the quorum error.
    if (count < quorumThreshold) {
      throwQuorumError(fallbackValues);
    }

    // If we've achieved quorum, then we should still log the providers that mismatched with the quorum result.
    const mismatchedProviders = getMismatchedProviders([...values, ...fallbackValues]);
    const quorumProviders = [...values, ...fallbackValues]
      .filter(([, result]) => compareRpcResults(method, result, quorumResult))
      .map(([provider]) => provider.connection.url);
    if (mismatchedProviders.length > 0 || errors.length > 0) {
      logQuorumMismatchOrFailureDetails(method, params, quorumProviders, mismatchedProviders, errors);
    }

    return quorumResult;
  }

  _validateResponse(method: string, _: Array<unknown>, response: unknown): boolean {
    // Basic validation logic to start.
    // Note: eth_getTransactionReceipt is ignored here because null responses are expected in the case that ethers is
    // polling for the transaction receipt and receiving null until it does.
    return isDefined(response) || method === "eth_getTransactionReceipt";
  }

  async _sendAndValidate(
    provider: ethers.providers.StaticJsonRpcProvider,
    method: string,
    params: Array<unknown>
  ): Promise<unknown> {
    const response = await provider.send(method, params);
    if (!this._validateResponse(method, params, response)) {
      // Not a warning to avoid spam since this could trigger a lot.
      this.logger?.debug({
        at: "ProviderUtils",
        message: "Provider returned invalid response",
        provider: getOriginFromURL(provider.connection.url),
        method,
        params,
        response,
      });
      throw new Error("Response failed validation");
    }
    return response;
  }

  /**
   * Validate and parse a possible JSON-RPC error response.
   * @param error An unknown error object received in response to a JSON-RPC request.
   * @returns A JSON-RPC error object, or undefined.
   */
  protected parseError(response: unknown): { code: number; message: string; data?: unknown } | undefined {
    if (!RpcError.is(response)) {
      return;
    }

    try {
      const error = JSON.parse(response.body);
      if (!JsonRpcError.is(error)) {
        return;
      }

      return error.error;
    } catch {
      return;
    }
  }

  /**
   * Determine whether a JSON-RPC error response indicates an unrecoverable error.
   * @param method JSON-RPC method that produced the error.
   * @param error JSON-RPC error instance.
   * @returns True if the request should be aborted immediately, otherwise false.
   */
  protected failImmediate(method: string, response: unknown): boolean {
    const err = this.parseError(response);
    if (!err) {
      return false; // Not a JSON-RPC error.
    }

    // [-32768, -32100] is reserved by the JSON-RPC spec.
    // [-32099, -32000] is allocated for implementation-defined responses.
    // Everything else is available for use by the application space.
    // Most node implementations return 3 for an eth_call revert, but some return -32000.
    // See also https://www.jsonrpc.org/specification
    if (err.code >= -32768 && err.code <= -32100) {
      return false; // Cannot handle these errors.
    }

    // The `data` member of err _may_ be populated but would need to be verified.
    const message = err.message.toLowerCase();
    switch (method) {
      case "eth_call":
      case "eth_estimateGas":
        return message.includes("revert"); // Transaction will fail.
      case "eth_sendRawTransaction":
        // Nonce too low or gas price is too low.
        return message.includes("nonce") || message.includes("underpriced");
      default:
        break;
    }

    return false;
  }

  async _trySend(
    provider: ethers.providers.StaticJsonRpcProvider,
    method: string,
    params: Array<unknown>
  ): Promise<unknown> {
    let { retries } = this;

    // eslint-disable-next-line no-constant-condition
    while (true) {
      const [settled] = await Promise.allSettled([this._sendAndValidate(provider, method, params)]);
      if (settled.status === "fulfilled") {
        return settled.value;
      }

      if (retries-- <= 0 || this.failImmediate(method, settled.reason)) {
        throw settled.reason;
      }
      await delay(this.delay);
    }
  }

  _getQuorum(method: string, params: Array<unknown>): number {
    // Only use quorum if this is a historical query that doesn't depend on the current block number.

    // All logs queries should use quorum.
    if (method === "eth_getLogs") {
      return this.nodeQuorumThreshold;
    }

    // getBlockByNumber should only use the quorum if it's not asking for the latest block.
    if (method === "eth_getBlockByNumber" && params[0] !== "latest" && params[0] !== "pending") {
      return this.nodeQuorumThreshold;
    }

    // eth_call should only use quorum for queries at a specific past block.
    if (method === "eth_call" && params[1] !== "latest") {
      return this.nodeQuorumThreshold;
    }

    // All other calls should use quorum 1 to avoid errors due to sync differences.
    return 1;
  }
}
