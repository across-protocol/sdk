import { clients } from "../../src";
import { DepositWithBlock } from "../../src/interfaces/SpokePool";
import { EvmAddress } from "../../src/utils";
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
  getL1TokenForDeposit(
    deposit: Pick<DepositWithBlock, "originChainId" | "inputToken" | "quoteBlockNumber">
  ): EvmAddress {
    // L1-->L2 token mappings are set via PoolRebalanceRoutes which occur on mainnet,
    // so we use the latest token mapping. This way if a very old deposit is filled, the relayer can use the
    // latest L2 token mapping to find the L1 token counterpart.
    return super.getL1TokenForDeposit(deposit);
  }

  /**
   * Returns the L2 token that should be used as a counterpart to a deposit event. For example, the caller
   * might want to know what the refund token will be on l2ChainId for the deposit event.
   * @param l2ChainId Chain where caller wants to get L2 token counterpart for
   * @param event Deposit event
   * @returns string L2 token counterpart on l2ChainId
   */
  getL2TokenForDeposit(
    deposit: Pick<DepositWithBlock, "originChainId" | "destinationChainId" | "inputToken" | "quoteBlockNumber">,
    l2ChainId = deposit.destinationChainId
  ): string {
    const l1Token = this.getL1TokenForDeposit(deposit);
    // Use the latest hub block number to find the L2 token counterpart.
    return this.getL2TokenForL1TokenAtBlock(l1Token, l2ChainId, deposit.quoteBlockNumber).toNative();
  }
}
