import { CachedSolanaRpcFactory } from "../solana/cachedRpcFactory";
import { MockRetrySolanaRpcFactory } from "./MockRetrySolanaRpcFactory";

// Creates mocked cached Solana RPC factory by using the mocked retry Solana RPC factory.
export class MockCachedSolanaRpcFactory extends CachedSolanaRpcFactory {
  constructor(
    mockRetrySolanaRpcFactory: MockRetrySolanaRpcFactory,
    ...cachedConstructorParams: ConstructorParameters<typeof CachedSolanaRpcFactory>
  ) {
    super(...cachedConstructorParams);

    this.retryTransport = mockRetrySolanaRpcFactory.createTransport();
    this.retryRpcClient = mockRetrySolanaRpcFactory.createRpcClient();
  }
}
