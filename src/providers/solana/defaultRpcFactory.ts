import { createDefaultRpcTransport, RpcTransport } from "@solana/web3-v2.js";
import { SolanaClusterRpcFactory } from "./baseRpcFactories";

// Exposes default RPC transport for Solana in the SolanaClusterRpcFactory class.
export class SolanaDefaultRpcFactory extends SolanaClusterRpcFactory {
  constructor(...clusterConstructorParams: ConstructorParameters<typeof SolanaClusterRpcFactory>) {
    super(...clusterConstructorParams);
  }

  public createTransport(): RpcTransport {
    return createDefaultRpcTransport({ url: this.clusterUrl });
  }
}
