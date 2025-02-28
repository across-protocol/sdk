import { RateLimitedSolanaRpcFactory } from "../../src/providers";
import { MockSolanaRpcFactory } from "./MockSolanaRpcFactory";

// Creates mocked rate limited Solana RPC factory by using the mocked Solana RPC factory.
export class MockRateLimitedSolanaRpcFactory extends RateLimitedSolanaRpcFactory {
  constructor(
    mockSolanaRpcFactory: MockSolanaRpcFactory,
    ...rateLimitedConstructorParams: ConstructorParameters<typeof RateLimitedSolanaRpcFactory>
  ) {
    super(...rateLimitedConstructorParams);

    this.defaultTransport = mockSolanaRpcFactory.createTransport();
  }
}
