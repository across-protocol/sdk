// StaticJsonRpcProvider is used in place of JsonRpcProvider to avoid redundant eth_chainId queries prior to each
// request. This is safe to use when the back-end provider is guaranteed not to change.
// See https://docs.ethers.io/v5/api/providers/jsonrpc-provider/#StaticJsonRpcProvider

import { QueueObject, queue } from "async";
import { ethers } from "ethers";
import { RateLimitTask } from "./utils";
import { getOriginFromURL } from "../utils/NetworkUtils";
import winston, { Logger } from "winston";

// This provider is a very small addition to the StaticJsonRpcProvider that ensures that no more than `maxConcurrency`
// requests are ever in flight. It uses the async/queue library to manage this.
export class RateLimitedProvider extends ethers.providers.StaticJsonRpcProvider {
  // The queue object that manages the tasks.
  private queue: QueueObject<RateLimitTask>;

  // Takes the same arguments as the JsonRpcProvider, but it has an additional maxConcurrency value at the beginning
  // of the list.
  constructor(
    maxConcurrency: number,
    readonly pctRpcCallsLogged: number,
    readonly logger: Logger = winston.createLogger({
      transports: [new winston.transports.Console()],
    }),
    ...cacheConstructorParams: ConstructorParameters<typeof ethers.providers.StaticJsonRpcProvider>
  ) {
    super(...cacheConstructorParams);

    // This sets up the queue. Each task is executed by calling the superclass's send method, which fires off the
    // request. This queue sends out requests concurrently, but stops once the concurrency limit is reached. The
    // maxConcurrency is configured here.
    this.queue = queue(async ({ sendArgs, resolve, reject }: RateLimitTask, callback: () => void) => {
      await this.wrapSendWithLog(...sendArgs)
        .then(resolve)
        .catch(reject);
      // we need this for the queue to know that the task is done
      // @see: https://caolan.github.io/async/v3/global.html
      callback();
    }, maxConcurrency);
  }

  async wrapSendWithLog(method: string, params: Array<unknown>) {
    if (this.pctRpcCallsLogged <= 0 || Math.random() > this.pctRpcCallsLogged / 100) {
      // Non sample path: no logging or timing, just issue the request.
      return super.send(method, params);
    } else {
      const loggerArgs = {
        at: "ProviderUtils",
        message: "Provider response sample",
        provider: getOriginFromURL(this.connection.url),
        method,
        params,
        chainId: this.network.chainId,
      };

      // In this path we log an rpc response sample.
      // Note: use performance.now() to ensure a purely monotonic clock.
      const startTime = performance.now();
      try {
        const result = await super.send(method, params);
        const elapsedTimeS = (performance.now() - startTime) / 1000;
        this.logger.debug({
          ...loggerArgs,
          success: true,
          timeElapsed: elapsedTimeS,
        });
        return result;
      } catch (error) {
        // Log errors as well.
        // For now, to keep logs light, don't log the error itself, just propogate and let it be handled higher up.
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

  override send(method: string, params: Array<unknown>): Promise<unknown> {
    // This simply creates a promise and adds the arguments and resolve and reject handlers to the task.
    return new Promise<unknown>((resolve, reject) => {
      const task: RateLimitTask = {
        sendArgs: [method, params],
        resolve,
        reject,
      };
      // We didn't previously wait for this push so we can emulate
      // the same behavior with the `void` keyword.
      void this.queue.push(task);
    });
  }
}
