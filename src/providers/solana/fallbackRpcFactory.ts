import { RpcFromTransport, RpcResponse, RpcTransport, SolanaRpcApiFromTransport } from "@solana/kit";
import { CachedSolanaRpcFactory } from "./cachedRpcFactory";
import { SolanaBaseRpcFactory, SolanaClusterRpcFactory } from "./baseRpcFactories";
import { isPromiseFulfilled, isPromiseRejected } from "../../utils/TypeGuards";
import { compareRpcResults, compareSvmRpcResults, createSendErrorWithMessage } from "../utils";

// This factory stores multiple Cached RPC factories so that users of this factory can specify multiple RPC providers
// and the factory will fallback through them if any RPC calls fail. Eventually, this class can be extended with
// quorum logic.
export class FallbackSolanaRpcFactory extends SolanaBaseRpcFactory {
  readonly rpcFactories: {
    transport: RpcTransport;
    rpcClient: RpcFromTransport<SolanaRpcApiFromTransport<RpcTransport>, RpcTransport>;
    rpcFactory: CachedSolanaRpcFactory;
  }[] = [];

  constructor(
    factoryConstructorParams: ConstructorParameters<typeof CachedSolanaRpcFactory>[],
    readonly nodeQuorumThreshold: number
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
            // Append the provider and error to the error array.
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            errors.push([factory.rpcFactory, (error as any)?.stack || error?.toString()]);

            if (fallbackFactories.length === 0) {
              throw error;
            }

            const nextFactory = fallbackFactories.shift()!;
            console.log(
              `Falling back to ${nextFactory.rpcFactory.clusterUrl}, new fallback providers length: ${fallbackFactories.length}`,
              error
            );
            return tryWithFallback(nextFactory, ...args);
          });
      };
      const results = await Promise.allSettled(
        requiredFactories.map((factory) => {
          console.log(
            `[${method}] Trying to call ${factory.rpcFactory.clusterUrl}, fallback providers length: ${fallbackFactories.length}`
          );
          return tryWithFallback<TResponse>(factory, ...args);
        })
      );

      if (!results.every(isPromiseFulfilled)) {
        // Format the error so that it's very clear which providers failed and succeeded.
        const errorTexts = errors.map(
          ([factory, errorText]) => `Provider ${factory.clusterUrl} failed with error ${errorText}`
        );
        const successfulProviderUrls = results.filter(isPromiseFulfilled).map((result) => result.value[0].clusterUrl);
        throw createSendErrorWithMessage(
          `Not enough providers succeeded. Errors:\n${errorTexts.join("\n")}\n` +
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

      const throwQuorumError = () => {
        const errorTexts = errors.map(
          ([factory, errorText]) => `Provider ${factory.clusterUrl} failed with error ${errorText}`
        );
        const successfulProviderUrls = values.map(([provider]) => provider.clusterUrl);
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
        throwQuorumError();
      }

      // Try each fallback provider in parallel.
      const fallbackResults = await Promise.allSettled(
        fallbackFactories.map((factory) =>
          factory
            .transport<TResponse>(...args)
            .then((result): [SolanaClusterRpcFactory, TResponse] => [factory.rpcFactory, result])
            .catch((err) => {
              errors.push([factory.rpcFactory, err?.stack || err?.toString()]);
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
        [[undefined, 0]] as [TResponse, number][] // Initialize with [undefined, 0] as the first element so something is always returned.
      );

      // Sort so the result with the highest count is first.
      counts.sort(([, a], [, b]) => b - a);

      // Extract the result by grabbing the first element.
      const [quorumResult, count] = counts[0];

      // If this count is less than we need for quorum, throw the quorum error.
      if (count < quorumThreshold) {
        throwQuorumError();
      }

      // TODO: Contains no error logging logic for now because logger isn't passed into this class.

      return quorumResult;
    };
  }

  _getQuorum(method: string, _params: Array<unknown>): number {
    // Only use quorum if this is a historical query that doesn't depend on the current block number.

    if (method === "getBlockTime") {
      return this.nodeQuorumThreshold;
    }

    // All other calls should use quorum 1 to avoid errors due to sync differences.
    return 1;
  }
}
