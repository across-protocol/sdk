import { Logger } from "winston";
import { RpcFromTransport, RpcResponse, RpcTransport, SolanaRpcApiFromTransport } from "@solana/kit";
import { isDefined, isPromiseFulfilled, isPromiseRejected } from "../../utils/TypeGuards";
import { compareSvmRpcResults, createSendErrorWithMessage } from "../utils";
import { CachedSolanaRpcFactory } from "./cachedRpcFactory";
import { SolanaBaseRpcFactory, SolanaClusterRpcFactory } from "./baseRpcFactories";
import { formatRpcError, isChainWideFailure, shouldFailImmediate } from "./utils";

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
    // An unsatisfiable threshold would otherwise be accepted silently: `requiredFactories` is a slice, so
    // it shrinks to the providers that exist and the all-agree early return below is trivially satisfied by
    // a single provider. That reports quorum while providing none. Mirrors RetryProvider's check.
    if (this.nodeQuorumThreshold > this.rpcFactories.length) {
      throw new Error(
        `nodeQuorumThreshold (${this.nodeQuorumThreshold}) must be <= the number of providers (${this.rpcFactories.length})`
      );
    }
  }

  public createTransport(): RpcTransport {
    return async <TResponse>(...args: Parameters<RpcTransport>): Promise<RpcResponse<TResponse>> => {
      const { method, params } = args[0].payload as { method: string; params?: unknown[] };
      const quorumThreshold = this._getQuorum(method, params ?? []);
      // A missing result only counts as a vote for methods where absence is a fact about the chain. See
      // ABSENCE_IS_PROVIDER_LOCAL.
      const absenceIsProviderLocal = ABSENCE_IS_PROVIDER_LOCAL.includes(method);
      const isMissingResult = (response: unknown) => absenceIsProviderLocal && !isDefined(unwrapRpcResult(response));
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

            // If the error is a deterministic, network-wide chain fact (slot skipped,
            // preflight failure), every fallback provider will return the same answer.
            // Skip the fallback so the chain rejects with the underlying SolanaError —
            // both to save RPC budget and to keep `rejections.every(shouldFailImmediate)`
            // below from being defeated by a non-Solana failure on a later fallback.
            // Note: `isChainWideFailure` is intentionally narrower than `shouldFailImmediate`.
            // SVM_LONG_TERM_STORAGE_SLOT_SKIPPED is provider-local (the slot may be missing from
            // *this* provider's archive but present elsewhere), so we still try fallbacks for it.
            if (isChainWideFailure(method, error)) {
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
      const allValuesAgree = values.slice(1).every(([, output]) => compareSvmRpcResults(method, values[0][1], output));
      // "Everyone agrees the transaction is missing" is only a real answer once there is nobody left to ask;
      // until then the required providers may simply be the pruned or lagging ones. Fall through to the
      // fallbacks so a provider that actually holds the transaction can overrule them.
      const missingNeedsCorroboration = isMissingResult(values[0][1]) && fallbackFactories.length > 0;

      // If _all_ values are equal, we have hit quorum, so return. The length check is belt-and-braces against
      // a `requiredFactories` slice shorter than the threshold; the constructor already rejects that config.
      if (allValuesAgree && values.length >= quorumThreshold && !missingNeedsCorroboration) {
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

      const allValues = [...values, ...fallbackValues];

      // Only providers that actually returned the transaction get a vote, so that a pruned or lagging node
      // cannot outvote an archival one and silently erase a real deposit or fill.
      const votingValues = allValues.filter(([, result]) => !isMissingResult(result));
      if (absenceIsProviderLocal && votingValues.length === 0) {
        // Nobody we consulted has it, so the absence is a property of the chain rather than of one provider.
        return allValues[0][1];
      }

      const [quorumResult, count] = getHighestCountResult(votingValues);
      // If this count is less than we need for quorum, throw the quorum error.

      if (count < quorumThreshold) {
        throwQuorumError(quorumResult, allValues);
      }

      // If we've achieved quorum, then we should still log the providers that mismatched with the quorum result.
      const mismatchedProviders = allValues
        .filter(([, result]) => !compareSvmRpcResults(method, result, quorumResult))
        .map(([factory]) => factory.clusterUrl);
      const successfulProviderUrls = allValues.map(([provider]) => provider.clusterUrl);
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
    //
    // getTransaction returns the instruction data that every SpokePool event (FundsDeposited, FilledRelay,
    // RequestedSlowFill, ...) is decoded from, so without quorum a single compromised provider can fabricate
    // a fill and drive a fraudulent relayer-refund leaf. It is historical and deterministic once the slot is
    // confirmed, which makes it safe to quorum — mirroring the eth_getLogs treatment in RetryProvider.
    //
    // getSignaturesForAddress is deliberately NOT quorumed. arch/svm/eventsClient fetches the newest page and
    // filters by slot afterwards instead of pinning the request, so the page tracks the confirmed tip: two
    // honest providers a slot apart return different leading signatures, and deep equality would fail quorum
    // and stall all event ingestion. This mirrors RetryProvider excluding "latest"/"pending" from
    // eth_getBlockByNumber quorum. It leaves an omission vector — a malicious provider can withhold
    // signatures — that needs a range-reconciling comparator rather than deep equality, so it is left to a
    // follow-up.
    switch (method) {
      case "getBlock":
      case "getBlockTime":
      case "getTransaction":
        return this.nodeQuorumThreshold;
    }

    // All other calls should use quorum 1 to avoid errors due to sync differences.
    return 1;
  }
}

// These methods return a bigint and their results are loggable because they are succinct and can further assist
// quorum debugging.
const METHODS_RETURNING_BIGINT = ["getBlockTime", "getSlot"];

// Methods whose null result is a statement about the queried provider rather than about the chain: a pruned or
// lagging node answering "I don't have this transaction" is not the same claim as "this transaction does not
// exist". arch/svm/eventsClient decodes a null transaction as "no events", so letting absence win a quorum vote
// would silently drop the deposit or fill instead of surfacing the disagreement.
const ABSENCE_IS_PROVIDER_LOCAL = ["getTransaction"];

// The SVM transports resolve to the JSON-RPC envelope ({ jsonrpc, id, result }); unwrap it so that a missing
// payload is detected whether we are handed the envelope or a bare result.
function unwrapRpcResult(response: unknown): unknown {
  if (isDefined(response) && typeof response === "object" && "result" in (response as Record<string, unknown>)) {
    return (response as Record<string, unknown>).result;
  }
  return response;
}
