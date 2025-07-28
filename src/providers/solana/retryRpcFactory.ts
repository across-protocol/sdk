import { RpcTransport } from "@solana/kit";
import { SolanaClusterRpcFactory } from "./baseRpcFactories";
import { RateLimitedSolanaRpcFactory } from "./rateLimitedRpcFactory";
import { delay } from "../../utils";
import { getOriginFromURL } from "../../utils/NetworkUtils";
import { Logger } from "winston";

// This factory adds retry logic on top of the RateLimitedSolanaRpcFactory.
// It follows the same composition pattern as other factories in this module.
export class RetrySolanaRpcFactory extends SolanaClusterRpcFactory {
  // Holds the underlying transport that the retry wrapper wraps.
  protected rateLimitedTransport: RpcTransport;

  protected logger: Logger;

  constructor(
    readonly retries: number,
    readonly retryDelaySeconds: number,
    ...rateLimitedConstructorParams: ConstructorParameters<typeof RateLimitedSolanaRpcFactory>
  ) {
    // SolanaClusterRpcFactory shares the last two constructor parameters with RateLimitedSolanaRpcFactory.
    const superParams = rateLimitedConstructorParams.slice(-2) as [
      ConstructorParameters<typeof SolanaClusterRpcFactory>[0], // clusterUrl: ClusterUrl
      ConstructorParameters<typeof SolanaClusterRpcFactory>[1], // chainId: number
    ];
    super(...superParams);

    // Validate retry configuration
    if (this.retries < 0 || !Number.isInteger(this.retries)) {
      throw new Error(`retries cannot be < 0 and must be an integer. Currently set to ${this.retries}`);
    }
    if (this.retryDelaySeconds < 0) {
      throw new Error(`retryDelaySeconds cannot be < 0. Currently set to ${this.retryDelaySeconds}`);
    }

    // Create the rate limited transport.
    const rateLimitedRpcFactory = new RateLimitedSolanaRpcFactory(...rateLimitedConstructorParams);
    this.rateLimitedTransport = rateLimitedRpcFactory.createTransport();
    this.logger = rateLimitedRpcFactory.logger;
  }

  public createTransport(): RpcTransport {
    return <TResponse>(...args: Parameters<RpcTransport>): Promise<TResponse> => {
      return this._tryCall(() => this.rateLimitedTransport<TResponse>(...args), args);
    };
  }

  /**
   * Retry wrapper for transport calls with Solana-specific error handling.
   * @param transportCall Function that makes the transport call
   * @param args Original transport arguments for logging
   * @returns Promise that resolves to the transport response
   */
  private async _tryCall<TResponse>(
    transportCall: () => Promise<TResponse>,
    args: Parameters<RpcTransport>
  ): Promise<TResponse> {
    const { method } = args[0].payload as { method: string; params?: unknown[] };
    let retryAttempt = 0;

    // eslint-disable-next-line no-constant-condition
    while (true) {
      try {
        return await transportCall();
      } catch (error) {
        if (retryAttempt++ >= this.retries || this.shouldFailImmediate(method, error)) {
          throw error;
        }

        // Implement a slightly aggressive exponential backoff to account for fierce parallelism.
        const exponentialBackoff = this.retryDelaySeconds * Math.pow(2, retryAttempt);
        const delayS = this.retryDelaySeconds + exponentialBackoff * Math.random();

        // Log retry attempt if logger is available
        this.logger.debug({
          at: "RetryRpcFactory",
          message: "Retrying Solana RPC call",
          provider: getOriginFromURL(this.clusterUrl),
          method,
          retryAttempt: retryAttempt,
          retryDelaySeconds: delayS,
          error: error?.toString(),
        });

        await delay(delayS);
      }
    }
  }

  /**
   * Determine whether a Solana RPC error indicates an unrecoverable error that should not be retried.
   * @param method RPC method name
   * @param error Error object from the RPC call
   * @returns True if the request should be aborted immediately, otherwise false
   */
  private shouldFailImmediate(_method: string, _error: unknown): boolean {
    // TODO: Decide which Solana RPC errors should be considered non-transitory and should not be retried.
    // For now, retry all errors.
    return false;
  }
}
