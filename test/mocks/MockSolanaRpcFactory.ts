import { RpcResponse, RpcTransport } from "@solana/web3.js";
import { SolanaClusterRpcFactory } from "../../src/providers";

// Exposes mocked RPC transport for Solana in the SolanaClusterRpcFactory class.
export class MockSolanaRpcFactory extends SolanaClusterRpcFactory {
  private responseTime: number; // in milliseconds
  private responses: Map<string, unknown> = new Map();

  constructor(...clusterConstructorParams: ConstructorParameters<typeof SolanaClusterRpcFactory>) {
    super(...clusterConstructorParams);
  }

  public createTransport(): RpcTransport {
    return <TResponse>(...args: Parameters<RpcTransport>): Promise<TResponse> => {
      return this.createMockRpcTransport()<TResponse>(...args);
    };
  }

  public setResult(method: string, params: unknown[], result: unknown) {
    const requestKey = JSON.stringify({ method, params });
    this.responses.set(requestKey, result);
  }

  public setResponseTime(responseTime: number) {
    this.responseTime = responseTime;
  }

  private createMockRpcTransport(): RpcTransport {
    return async <TResponse>({ payload }: Parameters<RpcTransport>[0]): Promise<RpcResponse<TResponse>> => {
      const { method, params } = payload as { method: string; params?: unknown[] };
      const requestKey = JSON.stringify({ method, params });
      let result = this.responses.get(requestKey);
      if (result === undefined) {
        const requestKeyWithoutParams = JSON.stringify({ method, params: [] });
        result = this.responses.get(requestKeyWithoutParams);
      }
      await new Promise((resolve) => setTimeout(resolve, this.responseTime));
      return { result } as TResponse;
    };
  }
}
