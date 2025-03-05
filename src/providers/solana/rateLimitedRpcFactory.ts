import { RpcResponse, RpcTransport } from "@solana/web3.js";
import { QueueObject, queue } from "async";
import winston, { Logger } from "winston";
import { SolanaClusterRpcFactory } from "./baseRpcFactories";
import { SolanaDefaultRpcFactory } from "./defaultRpcFactory";
import { SolanaRateLimitTask } from "./utils";
import { getOriginFromURL } from "../../utils";

// This factory is a very small addition to the SolanaDefaultRpcFactory that ensures that no more than maxConcurrency
// requests are ever in flight. It uses the async/queue library to manage this.
export class RateLimitedSolanaRpcFactory extends SolanaClusterRpcFactory {
  // The queue object that manages the tasks.
  private queue: QueueObject<SolanaRateLimitTask>;

  // Holds the underlying transport that the rate limiter wraps.
  protected defaultTransport: RpcTransport;

  // Takes the same arguments as the SolanaDefaultRpcFactory, but it has an additional parameters to control
  // concurrency and logging at the beginning of the list.
  constructor(
    maxConcurrency: number,
    readonly pctRpcCallsLogged: number,
    readonly logger: Logger = winston.createLogger({
      transports: [new winston.transports.Console()],
    }),
    ...defaultConstructorParams: ConstructorParameters<typeof SolanaDefaultRpcFactory>
  ) {
    super(...defaultConstructorParams);
    this.defaultTransport = new SolanaDefaultRpcFactory(...defaultConstructorParams).createTransport();

    // This sets up the queue. Each task is executed by forwarding the RPC request to the underlying base transport.
    // This queue sends out requests concurrently, but stops once the concurrency limit is reached. The maxConcurrency
    // is configured here.
    this.queue = queue(async ({ rpcArgs, resolve, reject }: SolanaRateLimitTask, callback: () => void) => {
      await this.wrapSendWithLog(...rpcArgs)
        .then(resolve)
        .catch(reject);
      // we need this for the queue to know that the task is done
      // @see: https://caolan.github.io/async/v3/global.html
      callback();
    }, maxConcurrency);
  }

  private async wrapSendWithLog(...rpcArgs: Parameters<RpcTransport>) {
    if (this.pctRpcCallsLogged <= 0 || Math.random() > this.pctRpcCallsLogged / 100) {
      // Non sample path: no logging or timing, just issue the request.
      return await this.defaultTransport(...rpcArgs);
    } else {
      const payload = rpcArgs[0].payload as { method: string; params?: unknown[] };
      const loggerArgs = {
        at: "SolanaProviderUtils",
        message: "Solana provider response sample",
        provider: getOriginFromURL(this.clusterUrl),
        method: payload.method,
        params: payload.params,
        chainId: this.chainId,
        datadog: true,
      };

      // In this path we log an rpc response sample.
      // Note: use performance.now() to ensure a purely monotonic clock.
      const startTime = performance.now();
      try {
        const result = await this.defaultTransport(...rpcArgs);
        const elapsedTimeS = (performance.now() - startTime) / 1000;
        this.logger.debug({
          ...loggerArgs,
          success: true,
          timeElapsed: elapsedTimeS,
        });
        return result;
      } catch (error) {
        // Log errors as well.
        // For now, to keep logs light, don't log the error itself, just propagate and let it be handled higher up.
        const elapsedTimeS = (performance.now() - startTime) / 1000;
        this.logger.debug({
          ...loggerArgs,
          success: false,
          timeElapsed: elapsedTimeS,
        });
        throw error;
      }
    }
  }

  public createTransport() {
    return <TResponse>(...args: Parameters<RpcTransport>): Promise<RpcResponse<TResponse>> => {
      // This simply creates a promise and adds the arguments and resolve and reject handlers to the task.
      return new Promise<RpcResponse<TResponse>>((resolve, reject) => {
        const task: SolanaRateLimitTask = {
          rpcArgs: args,
          resolve: resolve as (value: unknown) => void,
          reject,
        };
        // We didn't previously wait for this push so we can emulate
        // the same behavior with the `void` keyword.
        void this.queue.push(task);
      });
    };
  }
}
