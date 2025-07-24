import { clients } from "../../src";

export class MockSpokePoolClient extends clients.mocks.MockSpokePoolClient {}

export * from "../../src/providers/mocks/MockCachedSolanaRpcFactory";
export * from "./MockConfigStoreClient";
export * from "./MockHubPoolClient";
export * from "../../src/providers/mocks/MockRateLimitedSolanaRpcFactory";
export * from "../../src/providers/mocks/MockRetrySolanaRpcFactory";
export * from "../../src/providers/mocks/MockSolanaRpcFactory";
