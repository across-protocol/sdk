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
      return this.tryCallWithFallbacks<TResponse>(this.rpcFactories[0].transport, ...args)
        .then((result) => result)
        .catch((error) => {
          // If there are no new fallback providers to use, terminate the recursion by throwing an error.
          // Otherwise, we can try to call another provider.
          if (fallbackFactories.length === 0) {
            throw error;
          }

          const nextFactory = fallbackFactories.shift()!;
          console.log(`Falling back to ${nextFactory.rpcFactory.clusterUrl}`, error);
          return this.tryCallWithFallbacks(nextFactory.transport, ...args);
        });
    };
  }

  private tryCallWithFallbacks<TResponse>(
    transport: RpcTransport,
    ...args: Parameters<RpcTransport>
  ): Promise<RpcResponse<TResponse>> {
    return transport<TResponse>(...args);
  }
}
