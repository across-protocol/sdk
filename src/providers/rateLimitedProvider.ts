// StaticJsonRpcProvider is used in place of JsonRpcProvider to avoid redundant eth_chainId queries prior to each
// request. This is safe to use when the back-end provider is guaranteed not to change.
// See https://docs.ethers.io/v5/api/providers/jsonrpc-provider/#StaticJsonRpcProvider

import { QueueObject, queue } from "async";
import { ethers } from "ethers";
import { RateLimitTask } from "./utils";
import { getOriginFromURL } from "../utils/NetworkUtils";
import { delay } from "../utils/common";
import winston, { Logger } from "winston";

const LOG_EVERY_N_RATE_LIMIT_ERRORS = 100;

// Attaches the provider's own throttleCallback. ethers freezes ConnectionInfo and defines `connection` as
// non-writable, so this can only be installed ahead of super() — it cannot be patched onto a built provider. The
// callback is routed via `onThrottle` because `this` does not exist yet at that point.
function withThrottleCallback(
  params: ConstructorParameters<typeof ethers.providers.StaticJsonRpcProvider>,
  onThrottle: (attempt: number) => Promise<boolean>
): ConstructorParameters<typeof ethers.providers.StaticJsonRpcProvider> {
  const [connection, network] = params;
  if (typeof connection !== "object" || connection === null) {
    return params;
  }

  return [
    {
      ...connection,
      // Effectively disables ethers' internal backoff algorithm in favour of the one below. Note that ethers still
      // honours a `Retry-After` header when the provider sends one, independently of this.
      throttleSlotInterval: 1,
      throttleCallback: (attempt: number) => onThrottle(attempt),
    },
    network,
  ];
}

// This provider is a very small addition to the StaticJsonRpcProvider that ensures that no more than `maxConcurrency`
// requests are ever in flight. It uses the async/queue library to manage this.
export class RateLimitedProvider extends ethers.providers.StaticJsonRpcProvider {
  // The queue object that manages the tasks.
  private queue: QueueObject<RateLimitTask>;

  private rateLimitLogCounter = 0;

  // Takes the same arguments as the JsonRpcProvider, but it has an additional maxConcurrency value at the beginning
  // of the list.
  constructor(
    readonly maxConcurrency: number,
    readonly pctRpcCallsLogged: number,
    readonly logger: Logger = winston.createLogger({
      transports: [new winston.transports.Console()],
    }),
    ...cacheConstructorParams: ConstructorParameters<typeof ethers.providers.StaticJsonRpcProvider>
  ) {
    const throttle: { onThrottle: (attempt: number) => Promise<boolean> } = {
      onThrottle: () => Promise.resolve(true),
    };
    super(...withThrottleCallback(cacheConstructorParams, (attempt) => throttle.onThrottle(attempt)));
    throttle.onThrottle = (attempt) => this.onRateLimited(attempt);

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

  // The queue's current concurrency limit, which moves between 1 and maxConcurrency as the provider pushes back.
  get concurrency(): number {
    return this.queue.concurrency;
  }

  // Backoff on a rate-limit (429) response, plus feedback onto the queue: being throttled means we are outpacing
  // this provider, so narrow the queue as well as waiting. The number of attempts is bounded by ethers via
  // `connection.throttleLimit`, so this always asks for another attempt.
  private async onRateLimited(attempt: number): Promise<boolean> {
    this.queue.concurrency = Math.max(1, Math.floor(this.queue.concurrency / 2));

    // Slightly aggressive exponential backoff to account for fierce parallelism.
    const baseDelay = Math.pow(2, attempt); // seconds; attempt = [0, 1, 2, ...]
    const retryAfter = baseDelay + baseDelay * Math.random();

    if (this.rateLimitLogCounter++ % LOG_EVERY_N_RATE_LIMIT_ERRORS === 0) {
      this.logger.debug({
        at: "RateLimitedProvider#onRateLimited",
        message: `Got rate-limit (429) response on attempt ${attempt}.`,
        provider: getOriginFromURL(this.connection.url),
        retryAfter: `${retryAfter} s`,
        concurrency: this.queue.concurrency,
        maxConcurrency: this.maxConcurrency,
        datadog: true,
      });
    }
    await delay(retryAfter);

    return true;
  }

  // The other half of the feedback loop. An empty queue means we are no longer outpacing the provider, so widen back
  // towards maxConcurrency. Using the backlog as the signal is self-damping: under sustained load the queue stays
  // non-empty and the reduced concurrency holds, while an idle provider recovers quickly.
  private restoreConcurrency(): void {
    if (this.queue.concurrency < this.maxConcurrency && this.queue.length() === 0) {
      this.queue.concurrency += 1;
    }
  }

  async wrapSendWithLog(method: string, params: Array<unknown>) {
    if (this.pctRpcCallsLogged <= 0 || Math.random() > this.pctRpcCallsLogged / 100) {
      // Non sample path: no logging or timing, just issue the request.
      const result = await super.send(method, params);
      this.restoreConcurrency();
      return result;
    } else {
      const loggerArgs = {
        at: "ProviderUtils",
        message: "Provider response sample",
        provider: getOriginFromURL(this.connection.url),
        method,
        params,
        chainId: this.network.chainId,
        datadog: true,
      };

      // In this path we log an rpc response sample.
      // Note: use performance.now() to ensure a purely monotonic clock.
      const startTime = performance.now();
      try {
        const result = await super.send(method, params);
        this.restoreConcurrency();
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
