import { clients } from "../../src";
import { DepositWithBlock } from "../../src/interfaces/SpokePool";
import { Contract, winston } from "../utils";
import { MockConfigStoreClient } from "./MockConfigStoreClient";

// Adds functions to MockHubPoolClient to facilitate Dataworker unit testing.
export class MockHubPoolClient extends clients.mocks.MockHubPoolClient {
  public latestBundleEndBlocks: { [chainId: number]: number } = {};

  constructor(
    logger: winston.Logger,
    hubPool: Contract,
    configStoreClient: MockConfigStoreClient,
    deploymentBlock = 0,
    chainId = 1
  ) {
    super(logger, hubPool, configStoreClient, deploymentBlock, chainId);
  }

  setLatestBundleEndBlockForChain(chainId: number, latestBundleEndBlock: number): void {
    this.latestBundleEndBlocks[chainId] = latestBundleEndBlock;
  }
  getLatestBundleEndBlockForChain(chainIdList: number[], latestMainnetBlock: number, chainId: number): number {
    return (
      this.latestBundleEndBlocks[chainId] ??
      super.getLatestBundleEndBlockForChain(chainIdList, latestMainnetBlock, chainId) ??
      0
    );
  }
  getL1TokenForDeposit(deposit: Pick<DepositWithBlock, "originChainId" | "inputToken" | "quoteBlockNumber">): string {
    // L1-->L2 token mappings are set via PoolRebalanceRoutes which occur on mainnet,
    // so we use the latest token mapping. This way if a very old deposit is filled, the relayer can use the
    // latest L2 token mapping to find the L1 token counterpart.
    return this.getL1TokenForDeposit(deposit);
  }
}
