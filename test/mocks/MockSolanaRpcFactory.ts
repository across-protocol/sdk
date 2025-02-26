import { RpcResponse, RpcTransport } from "@solana/web3.js";
import { SolanaClusterRpcFactory } from "../../src/providers";

// Exposes mocked RPC transport for Solana in the SolanaClusterRpcFactory class.
export class MockSolanaRpcFactory extends SolanaClusterRpcFactory {
  private result: unknown;
  private responseTime: number; // in milliseconds

  constructor(...clusterConstructorParams: ConstructorParameters<typeof SolanaClusterRpcFactory>) {
    super(...clusterConstructorParams);
  }

  public createTransport(): RpcTransport {
    return <TResponse>(...args: Parameters<RpcTransport>): Promise<TResponse> => {
      return this.createMockRpcTransport()<TResponse>(...args);
    };
  }

  public setResult(result: unknown) {
    this.result = result;
  }

  public setResponseTime(responseTime: number) {
    this.responseTime = responseTime;
  }

  private createMockRpcTransport(): RpcTransport {
    return async <TResponse>(): Promise<RpcResponse<TResponse>> => {
      await new Promise((resolve) => setTimeout(resolve, this.responseTime));
      return { result: this.result } as TResponse;
    };
  }
}
