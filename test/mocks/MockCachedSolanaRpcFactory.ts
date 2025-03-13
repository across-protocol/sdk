import { CachedSolanaRpcFactory } from "../../src/providers";
import { MockRateLimitedSolanaRpcFactory } from "./MockRateLimitedSolanaRpcFactory";

// Creates mocked cached Solana RPC factory by using the mocked Solana RPC factory.
export class MockCachedSolanaRpcFactory extends CachedSolanaRpcFactory {
  constructor(
    mockRateLimitedSolanaRpcFactory: MockRateLimitedSolanaRpcFactory,
    ...cachedConstructorParams: ConstructorParameters<typeof CachedSolanaRpcFactory>
  ) {
    super(...cachedConstructorParams);

    this.rateLimitedTransport = mockRateLimitedSolanaRpcFactory.createTransport();
    this.rateLimitedRpcClient = mockRateLimitedSolanaRpcFactory.createRpcClient();
  }
}
