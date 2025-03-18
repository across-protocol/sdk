import { RpcResponse, RpcTransport } from "@solana/kit";
import { SolanaClusterRpcFactory } from "../../src/providers";

type CachedResponse = { result: unknown } | { error: unknown } | { throwError: string };

// Exposes mocked RPC transport for Solana in the SolanaClusterRpcFactory class.
export class MockSolanaRpcFactory extends SolanaClusterRpcFactory {
  private responseTime: number; // in milliseconds
  private responses: Map<string, CachedResponse> = new Map();

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
    this.responses.set(requestKey, { result });
  }

  public setError(method: string, params: unknown[], error: unknown) {
    const requestKey = JSON.stringify({ method, params });
    this.responses.set(requestKey, { error });
  }

  public setThrow(method: string, params: unknown[], throwError: string) {
    const requestKey = JSON.stringify({ method, params });
    this.responses.set(requestKey, { throwError });
  }

  public setResponseTime(responseTime: number) {
    this.responseTime = responseTime;
  }

  private createMockRpcTransport(): RpcTransport {
    return async <TResponse>({ payload }: Parameters<RpcTransport>[0]): Promise<RpcResponse<TResponse>> => {
      const { method, params } = payload as { method: string; params?: unknown[] };
      const requestKey = JSON.stringify({ method, params });
      let jsonRpcResponse = this.responses.get(requestKey);
      if (jsonRpcResponse === undefined) {
        const requestKeyWithoutParams = JSON.stringify({ method, params: [] });
        jsonRpcResponse = this.responses.get(requestKeyWithoutParams);
        if (jsonRpcResponse === undefined) jsonRpcResponse = { result: null };
      }
      await new Promise((resolve) => setTimeout(resolve, this.responseTime));
      if ("throwError" in jsonRpcResponse) throw new Error(jsonRpcResponse.throwError);
      return jsonRpcResponse as TResponse;
    };
  }
}
