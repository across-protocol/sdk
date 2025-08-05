import { RpcFromTransport, RpcResponse, RpcTransport, SolanaRpcApiFromTransport } from "@solana/kit";
import { CachedSolanaRpcFactory } from "./cachedRpcFactory";
import { SolanaBaseRpcFactory } from "./baseRpcFactories";

// This factory stores multiple Cached RPC factories so that users of this factory can specify multiple RPC providers
// and the factory will fallback through them if any RPC calls fail. Eventually, this class can be extended with
// quorum logic.
export class FallbackSolanaRpcFactory extends SolanaBaseRpcFactory {
  readonly rpcFactories: {
    transport: RpcTransport;
    rpcClient: RpcFromTransport<SolanaRpcApiFromTransport<RpcTransport>, RpcTransport>;
    rpcFactory: CachedSolanaRpcFactory;
  }[] = [];

  constructor(factoryConstructorParams: ConstructorParameters<typeof CachedSolanaRpcFactory>[]) {
    super();
    factoryConstructorParams.forEach((params) => {
      const rpcFactory = new CachedSolanaRpcFactory(...params);
      this.rpcFactories.push({
        transport: rpcFactory.createTransport(),
        rpcClient: rpcFactory.createRpcClient(),
        rpcFactory,
      });
    });
  }

  public createTransport(): RpcTransport {
    return <TResponse>(...args: Parameters<RpcTransport>): Promise<RpcResponse<TResponse>> => {
      const fallbackFactories = [...this.rpcFactories.slice(1)];

      const tryWithFallback = <TResponse>(
        transport: RpcTransport,
        ...args: Parameters<RpcTransport>
      ): Promise<RpcResponse<TResponse>> => {
        return transport<TResponse>(...args)
          .then((result) => result)
          .catch((error) => {
            if (fallbackFactories.length === 0) {
              throw error;
            }

            const nextFactory = fallbackFactories.shift()!;
            console.log(
              `Falling back to ${nextFactory.rpcFactory.clusterUrl}, new fallback providers length: ${fallbackFactories.length}`,
              error
            );
            return tryWithFallback(nextFactory.transport, ...args);
          });
      };
      const { method } = args[0].payload as { method: string; params?: unknown[] };
      console.log(
        `[${method}] Trying to call ${this.rpcFactories[0].rpcFactory.clusterUrl}, fallback providers length: ${fallbackFactories.length}`
      );
      return tryWithFallback<TResponse>(this.rpcFactories[0].transport, ...args);
    };
  }
}
