import { Logger } from "winston";
import { RpcFromTransport, RpcResponse, RpcTransport, SolanaRpcApiFromTransport } from "@solana/kit";
import { isPromiseFulfilled, isPromiseRejected } from "../../utils/TypeGuards";
import { compareSvmRpcResults, createSendErrorWithMessage } from "../utils";
import { CachedSolanaRpcFactory } from "./cachedRpcFactory";
import { SolanaBaseRpcFactory, SolanaClusterRpcFactory } from "./baseRpcFactories";
import { formatRpcError, shouldFailImmediate } from "./utils";

// This factory stores multiple Cached RPC factories so that users of this factory can specify multiple RPC providers
// and the factory will fallback through them if any RPC calls fail. This factory also implements quorum logic amongst
// the RPC providers.
export class QuorumFallbackSolanaRpcFactory extends SolanaBaseRpcFactory {
  readonly rpcFactories: {
    transport: RpcTransport;
    rpcClient: RpcFromTransport<SolanaRpcApiFromTransport<RpcTransport>, RpcTransport>;
    rpcFactory: CachedSolanaRpcFactory;
  }[] = [];

  constructor(
    factoryConstructorParams: ConstructorParameters<typeof CachedSolanaRpcFactory>[],
    readonly nodeQuorumThreshold: number,
    readonly logger: Logger
  ) {
    super();
    factoryConstructorParams.forEach((params) => {
      const rpcFactory = new CachedSolanaRpcFactory(...params);
      this.rpcFactories.push({
        transport: rpcFactory.createTransport(),
        rpcClient: rpcFactory.createRpcClient(),
        rpcFactory,
      });
    });
    if (this.nodeQuorumThreshold < 1 || !Number.isInteger(this.nodeQuorumThreshold)) {
      throw new Error(
        `nodeQuorum,Threshold cannot be < 1 and must be an integer. Currently set to ${this.nodeQuorumThreshold}`
      );
    }
  }

  public createTransport(): RpcTransport {
    return async <TResponse>(...args: Parameters<RpcTransport>): Promise<RpcResponse<TResponse>> => {
      const { method, params } = args[0].payload as { method: string; params?: unknown[] };

      // Methods whose results converge across providers but never agree exactly at the chain head
      // (e.g. `getSlot`) cannot use strict-equality quorum. Use a lower-bound quorum instead:
      // query all providers and return the K-th highest value, i.e. the highest value that at least
      // K providers report the chain has reached. This rejects a single lagging provider when N>K
      // and forces a single outlier-high provider to have at least one ally to influence the result.
      // Guarded on `nodeQuorumThreshold > 1` so quorum=1 bots keep the single-provider fast path.
      if (LOWER_BOUND_QUORUM_METHODS.includes(method) && this.nodeQuorumThreshold > 1) {
        return this._lowerBoundQuorumCall<TResponse>(method, params ?? [], ...args);
      }

      const quorumThreshold = this._getQuorum(method, params ?? []);
      const requiredFactories = this.rpcFactories.slice(0, quorumThreshold);
      const fallbackFactories = [...this.rpcFactories.slice(quorumThreshold)];
      const errors: [SolanaClusterRpcFactory, string][] = [];

      const tryWithFallback = <TResponse>(
        factory: {
          transport: RpcTransport;
          rpcClient: RpcFromTransport<SolanaRpcApiFromTransport<RpcTransport>, RpcTransport>;
          rpcFactory: CachedSolanaRpcFactory;
        },
        ...args: Parameters<RpcTransport>
      ): Promise<[SolanaClusterRpcFactory, RpcResponse<TResponse>]> => {
        return factory
          .transport<TResponse>(...args)
          .then((result): [SolanaClusterRpcFactory, RpcResponse<TResponse>] => [factory.rpcFactory, result])
          .catch((error) => {
            // Preserve the underlying JSON-RPC error code in the wrap message.
            errors.push([factory.rpcFactory, formatRpcError(error)]);

            // If all fallback providers fail, then return the last received error.
            if (fallbackFactories.length === 0) {
              throw error;
            }

            // If one RPC provider reverted, others likely will too. Skip them and preserve the
            // original error so callers can branch on `isSolanaError(...)`.
            if (quorumThreshold === 1 && shouldFailImmediate(method, error)) {
              throw error;
            }

            const currentFactory = factory.rpcFactory.clusterUrl;
            const nextFactory = fallbackFactories.shift()!;
            this.logger.debug({
              at: "FallbackSolanaRpcFactory#createTransport::tryWithFallback",
              message: `[${method}] ${currentFactory} failed, falling back to ${nextFactory.rpcFactory.clusterUrl}, new fallback providers length: ${fallbackFactories.length}`,
              method,
              jsonError: error,
            });
            return tryWithFallback(nextFactory, ...args);
          });
      };
      const results = await Promise.allSettled(
        requiredFactories.map((factory) => {
          return tryWithFallback<TResponse>(factory, ...args);
        })
      );

      const getErrorStrings = () => {
        return errors.map(
          ([factory, errorText]) => `Provider ${factory.clusterUrl} failed to call ${method} with error ${errorText}`
        );
      };

      if (!results.every(isPromiseFulfilled)) {
        // If every rejection is shouldFailImmediate, rethrow the original so callers can branch
        // on `isSolanaError(...)` rather than seeing a wrapped Error.
        const rejections = results.filter(isPromiseRejected);
        if (rejections.length > 0 && rejections.every(({ reason }) => shouldFailImmediate(method, reason))) {
          throw rejections[0].reason;
        }

        // Format the error so that it's very clear which providers failed and succeeded.
        const errorTexts = getErrorStrings();
        const successfulProviderUrls = results.filter(isPromiseFulfilled).map((result) => result.value[0].clusterUrl);
        throw createSendErrorWithMessage(
          `Not enough providers succeeded on ${method} call. Errors:\n${errorTexts.join("\n")}\n` +
            `Successful Providers:\n${successfulProviderUrls.join("\n")}`,
          results.find(isPromiseRejected)?.reason
        );
      }

      const values = results.map((result) => result.value);
      // Start at element 1 and begin comparing.
      // If _all_ values are equal, we have hit quorum, so return.
      if (values.slice(1).every(([, output]) => compareSvmRpcResults(method, values[0][1], output))) {
        return values[0][1];
      }

      const getHighestCountResult = (values: [SolanaClusterRpcFactory, TResponse][]): [TResponse, number] => {
        // Group the results by the count of that result.
        const counts = [...values].reduce(
          (acc, curr) => {
            const [, result] = curr;

            // Find the first result that matches the return value.
            const existingMatch = acc.find(([existingResult]) => compareSvmRpcResults(method, existingResult, result));

            // Increment the count if a match is found, else add a new element to the match array with a count of 1.
            if (existingMatch) {
              existingMatch[1]++;
            } else {
              acc.push([result, 1]);
            }

            // Return the same acc object because it was modified in place.
            return acc;
          },
          [[undefined, 0]] as [TResponse, number][] // Initialize with [undefined, 0] as the first element so something is always returned.
        );
        // Sort so the result with the highest count is first.
        counts.sort(([, a], [, b]) => b - a);

        // Extract the result by grabbing the first element.
        const [mostFrequentResult, count] = counts[0];
        return [mostFrequentResult, count];
      };

      const logQuorumMismatchOrFailureDetails = (
        method: string,
        params: Array<unknown>,
        mismatchedProviders: string[],
        successfulProviders: string[],
        errors: [SolanaClusterRpcFactory, string][],
        quorumResult: TResponse
      ) => {
        this.logger.warn({
          at: "FallbackSolanaRpcFactory#createTransport",
          message: `[${method}] Some providers mismatched with the quorum result or failed 🚸`,
          notificationPath: "across-warn",
          method,
          params: JSON.stringify(params),
          quorumResult: METHODS_RETURNING_BIGINT.includes(method) ? Number(quorumResult) : undefined,
          mismatchedProviders,
          successfulProviders,
          erroringProviders: errors.map(
            ([factory, errorText]) => `Provider ${factory.clusterUrl} failed with error ${errorText}`
          ),
        });
      };

      const throwQuorumError = (mostFrequentResult: TResponse, allValues: [SolanaClusterRpcFactory, TResponse][]) => {
        const errorTexts = getErrorStrings();
        const successfulProviderUrls = values.map(([provider]) => provider.clusterUrl);
        const mismatchedProviders = allValues
          .filter(([, result]) => !compareSvmRpcResults(method, result, mostFrequentResult))
          .map(([factory]) => factory.clusterUrl);
        logQuorumMismatchOrFailureDetails(
          method,
          params ?? [],
          mismatchedProviders,
          successfulProviderUrls,
          errors,
          mostFrequentResult
        );
        throw new Error(
          "Not enough providers agreed to meet quorum.\n" +
            "Providers that errored:\n" +
            `${errorTexts.join("\n")}\n` +
            "Providers that succeeded, but some failed to match:\n" +
            successfulProviderUrls.join("\n")
        );
      };

      // Exit early if there are no fallback providers left.
      if (fallbackFactories.length === 0) {
        const [mostFrequentResult] = getHighestCountResult(values);
        throwQuorumError(mostFrequentResult, values);
      }

      // Try each fallback provider in parallel.
      const fallbackResults = await Promise.allSettled(
        fallbackFactories.map((factory) => {
          return factory
            .transport<TResponse>(...args)
            .then((result): [SolanaClusterRpcFactory, TResponse] => [factory.rpcFactory, result])
            .catch((err) => {
              errors.push([factory.rpcFactory, formatRpcError(err)]);
              throw new Error("Fallback RPC call failed while trying to reach quorum");
            });
        })
      );

      // This filters only the fallbacks that succeeded.
      const fallbackValues = fallbackResults.filter(isPromiseFulfilled).map((promise) => promise.value);

      const [quorumResult, count] = getHighestCountResult([...values, ...fallbackValues]);
      // If this count is less than we need for quorum, throw the quorum error.

      if (count < quorumThreshold) {
        throwQuorumError(quorumResult, [...values, ...fallbackValues]);
      }

      // If we've achieved quorum, then we should still log the providers that mismatched with the quorum result.
      const mismatchedProviders = [...values, ...fallbackValues]
        .filter(([, result]) => !compareSvmRpcResults(method, result, quorumResult))
        .map(([factory]) => factory.clusterUrl);
      const successfulProviderUrls = [...values, ...fallbackValues].map(([provider]) => provider.clusterUrl);
      if (mismatchedProviders.length > 0 || errors.length > 0) {
        logQuorumMismatchOrFailureDetails(
          method,
          params ?? [],
          mismatchedProviders,
          successfulProviderUrls,
          errors,
          quorumResult
        );
      }

      return quorumResult;
    };
  }

  _getQuorum(method: string, _params: Array<unknown>): number {
    // Only use quorum if this is a historical query that doesn't depend on the current block number.

    switch (method) {
      case "getBlock":
      case "getBlockTime":
        return this.nodeQuorumThreshold;
    }

    // All other calls should use quorum 1 to avoid errors due to sync differences.
    return 1;
  }

  // Aggregate a chain-tip query under a "lower-bound quorum": query every configured provider in
  // parallel, sort the successful bigint responses descending, and return the value at index
  // (nodeQuorumThreshold - 1). Semantically: "at least nodeQuorumThreshold providers report the
  // chain has reached at least this slot." The K-th highest is rejected only if all providers
  // above it are colluding (or simply wrong in the same direction).
  private async _lowerBoundQuorumCall<TResponse>(
    method: string,
    params: unknown[],
    ...args: Parameters<RpcTransport>
  ): Promise<RpcResponse<TResponse>> {
    const errors: [SolanaClusterRpcFactory, string][] = [];

    const settled = await Promise.allSettled(
      this.rpcFactories.map((factory) =>
        factory
          .transport<TResponse>(...args)
          .then((value): [SolanaClusterRpcFactory, RpcResponse<TResponse>] => [factory.rpcFactory, value])
          .catch((error) => {
            errors.push([factory.rpcFactory, formatRpcError(error)]);
            throw error;
          })
      )
    );

    const successful = settled.filter(isPromiseFulfilled).map((r) => r.value);

    if (successful.length < this.nodeQuorumThreshold) {
      const errorTexts = errors.map(
        ([factory, errorText]) => `Provider ${factory.clusterUrl} failed to call ${method} with error ${errorText}`
      );
      const successfulProviderUrls = successful.map(([factory]) => factory.clusterUrl);
      throw createSendErrorWithMessage(
        `Not enough providers succeeded on ${method} call to reach lower-bound quorum ` +
          `(${successful.length}/${this.nodeQuorumThreshold}). Errors:\n${errorTexts.join("\n")}\n` +
          `Successful Providers:\n${successfulProviderUrls.join("\n")}`,
        settled.find(isPromiseRejected)?.reason
      );
    }

    // Sort successful responses by their underlying bigint value, highest first.
    const ranked = successful
      .map(([factory, value]) => ({ factory, value: value as unknown as bigint }))
      .sort((a, b) => (a.value === b.value ? 0 : a.value < b.value ? 1 : -1));
    const quorumValue = ranked[this.nodeQuorumThreshold - 1].value;
    const quorumResult = quorumValue as unknown as RpcResponse<TResponse>;

    const divergentProviders = ranked
      .filter(({ value }) => value !== quorumValue)
      .map(({ factory }) => factory.clusterUrl);
    if (divergentProviders.length > 0 || errors.length > 0) {
      this.logger.warn({
        at: "FallbackSolanaRpcFactory#createTransport",
        message: `[${method}] Lower-bound quorum: some providers diverged from the quorum value or failed 🚸`,
        notificationPath: "across-warn",
        method,
        params: JSON.stringify(params),
        quorumValue: Number(quorumValue),
        providerValues: ranked.map(({ factory, value }) => ({
          provider: factory.clusterUrl,
          value: Number(value),
        })),
        divergentProviders,
        successfulProviders: ranked.map(({ factory }) => factory.clusterUrl),
        erroringProviders: errors.map(
          ([factory, errorText]) => `Provider ${factory.clusterUrl} failed with error ${errorText}`
        ),
      });
    }

    return quorumResult;
  }
}

// These methods return a bigint and their results are loggable because they are succinct and can further assist
// quorum debugging.
const METHODS_RETURNING_BIGINT = ["getBlockTime", "getSlot"];

// Methods whose results converge but never agree exactly across providers when queried at the head
// of the chain. These cannot use strict-equality quorum and instead use lower-bound quorum
// (Kth-highest aggregation) inside `_lowerBoundQuorumCall`. The underlying response must be a
// bigint so the values are linearly orderable.
const LOWER_BOUND_QUORUM_METHODS = ["getSlot"];
