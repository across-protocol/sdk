import { ClusterUrl, createSolanaRpcFromTransport, RpcTransport } from "@solana/web3.js";

// This is abstract base class for creating Solana RPC clients and transports.
export abstract class SolanaBaseRpcFactory {
  constructor(readonly chainId: number) {}

  // This method must be implemented by the derived class to create a transport.
  public abstract createTransport(): RpcTransport;

  // This method creates a Solana RPC client from the implemented transport.
  public createRpcClient() {
    return createSolanaRpcFromTransport(this.createTransport());
  }
}

// Enhanced class for creating Solana RPC clients and transports storing additional cluster info.
// This can be used by derived classes that are connected to a single base transport.
export abstract class SolanaClusterRpcFactory extends SolanaBaseRpcFactory {
  constructor(
    readonly clusterUrl: ClusterUrl,
    ...baseConstructorParams: ConstructorParameters<typeof SolanaBaseRpcFactory>
  ) {
    super(...baseConstructorParams);
  }
}
