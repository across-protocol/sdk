import { clients } from "../../src";

export class MockSpokePoolClient extends clients.mocks.MockSpokePoolClient {}

export * from "./MockCachedSolanaRpcFactory";
export * from "./MockConfigStoreClient";
export * from "./MockHubPoolClient";
export * from "./MockRateLimitedSolanaRpcFactory";
export * from "./MockSolanaRpcFactory";
