import { RetrySolanaRpcFactory } from "..";
import { MockRateLimitedSolanaRpcFactory } from "./MockRateLimitedSolanaRpcFactory";

// Creates mocked retry Solana RPC factory by using the mocked rate limited Solana RPC factory.
export class MockRetrySolanaRpcFactory extends RetrySolanaRpcFactory {
  constructor(
    mockRateLimitedSolanaRpcFactory: MockRateLimitedSolanaRpcFactory,
    ...retryConstructorParams: ConstructorParameters<typeof RetrySolanaRpcFactory>
  ) {
    super(...retryConstructorParams);

    // Use the mock rate limited transport instead of creating a real one
    this.rateLimitedTransport = mockRateLimitedSolanaRpcFactory.createTransport();
    this.logger = mockRateLimitedSolanaRpcFactory.logger;
  }
}
