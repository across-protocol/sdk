import { AcrossConfigStoreClient as ConfigStoreClient, HubPoolClient } from "../src/clients";
import { getWidestPossibleExpectedBlockRange } from "../src/clients/BundleDataClient/utils/PoolRebalanceUtils";
import { SpokePoolClient } from "../src/clients/SpokePoolClient";
import { Clients } from "../src/interfaces";
import * as constants from "./constants";
import {
  BigNumber,
  Contract,
  SignerWithAddress,
  buildPoolRebalanceLeafTree,
  buildPoolRebalanceLeaves,
  createSpyLogger,
  deployConfigStore,
  ethers,
  expect,
  toBN,
  toBNWei,
  winston,
} from "./utils";
import { setupHubPool } from "./fixtures/HubPool.Fixture";

let hubPool: Contract, timer: Contract;
let l1Token_1: Contract, l1Token_2: Contract;
let dataworker: SignerWithAddress, owner: SignerWithAddress;
let logger: winston.Logger;

let hubPoolClient: HubPoolClient;
let configStoreClient: ConfigStoreClient;

// The chain that stays enabled throughout, and the chain that gets disabled mid-liveness.
const enabledChainId = constants.originChainId;
const disabledChainId = constants.destinationChainId;
const chainIds = [enabledChainId, disabledChainId];

// Bundle end blocks for the fully executed bundle and for the bundle left in liveness.
const executedBundleEndBlocks = [100, 200];
const pendingBundleEndBlocks = [150, 250];

const endBlockBuffers = [0, 0];

async function constructSimpleTree(runningBalance: BigNumber) {
  const netSendAmount = runningBalance.mul(toBN(-1));
  const bundleLpFees = toBNWei(1);
  const leaves = buildPoolRebalanceLeaves(
    [enabledChainId, disabledChainId], // Where funds are getting sent.
    [[l1Token_1.address, l1Token_2.address], [l1Token_2.address]], // l1Token.
    [[bundleLpFees, bundleLpFees.mul(toBN(2))], [bundleLpFees.mul(toBN(2))]], // bundleLpFees.
    [[netSendAmount, netSendAmount.mul(toBN(2))], [netSendAmount.mul(toBN(2))]], // netSendAmounts.
    [[runningBalance, runningBalance.mul(toBN(2))], [runningBalance.mul(toBN(3))]], // runningBalances.
    [0, 0] // groupId. Doesn't matter for this test.
  );

  const tree = await buildPoolRebalanceLeafTree(leaves);
  return { leaves, tree };
}

// getWidestPossibleExpectedBlockRange only reads `latestHeightSearched` off the spoke clients, and only for chains
// that are enabled, so a minimal stub is sufficient here.
function stubSpokeClients(heights: { [chainId: number]: number }): { [chainId: number]: SpokePoolClient } {
  return Object.fromEntries(
    Object.entries(heights).map(([chainId, latestHeightSearched]) => [
      chainId,
      { latestHeightSearched } as unknown as SpokePoolClient,
    ])
  );
}

describe("BundleDataClient: widest possible block ranges", function () {
  beforeEach(async function () {
    ({ hubPool, l1Token_1, l1Token_2, timer, owner, dataworker } = await setupHubPool(
      ethers,
      constants.MAX_REFUNDS_PER_RELAYER_REFUND_LEAF,
      constants.MAX_L1_TOKENS_PER_POOL_REBALANCE_LEAF
    ));

    logger = createSpyLogger().spyLogger;
    const { configStore, deploymentBlock: fromBlock } = await deployConfigStore(owner, [l1Token_1, l1Token_2]);
    configStoreClient = new ConfigStoreClient(logger, configStore, { from: fromBlock }, constants.CONFIG_STORE_VERSION);
    await configStoreClient.update();

    hubPoolClient = new HubPoolClient(logger, hubPool, configStoreClient);

    // Propose and fully execute one bundle, then leave a second bundle in liveness. This reproduces the state the
    // proposer sees when it chains a proposal off a bundle that has not been executed yet.
    const { tree: executedTree, leaves: executedLeaves } = await constructSimpleTree(toBNWei(100));
    const { tree: pendingTree } = await constructSimpleTree(toBNWei(100));

    await hubPoolClient.update();
    await hubPool
      .connect(dataworker)
      .proposeRootBundle(
        executedBundleEndBlocks,
        1,
        executedTree.getHexRoot(),
        constants.mockTreeRoot,
        constants.mockTreeRoot
      );
    await timer.setCurrentTime(Number(await timer.getCurrentTime()) + constants.refundProposalLiveness + 1);
    await hubPool
      .connect(dataworker)
      .executeRootBundle(...Object.values(executedLeaves[0]), executedTree.getHexProof(executedLeaves[0]));

    await hubPool
      .connect(dataworker)
      .proposeRootBundle(
        pendingBundleEndBlocks,
        1,
        pendingTree.getHexRoot(),
        constants.mockTreeRoot,
        constants.mockTreeRoot
      );
    await hubPoolClient.update();

    expect(hubPoolClient.hasPendingProposal()).to.equal(true);
  });

  it("freezes a disabled chain at the pending proposal's end block in optimistic mode", async function () {
    // The enabled chain has advanced well past the pending proposal's end block.
    const spokeClients = stubSpokeClients({ [enabledChainId]: 1000 });
    const latestMainnetBlock = await hubPool.provider.getBlockNumber();

    const blockRanges = await getWidestPossibleExpectedBlockRange(
      chainIds,
      spokeClients,
      endBlockBuffers,
      { hubPoolClient, configStoreClient } as Clients,
      latestMainnetBlock,
      [enabledChainId], // disabledChainId is absent, i.e. disabled.
      true // optimistic
    );

    // The enabled chain chains off the pending proposal...
    expect(blockRanges[0]).to.deep.equal([pendingBundleEndBlocks[0] + 1, 1000]);

    // ...so the disabled chain must freeze at the pending proposal's end block too. Freezing it at the latest *fully
    // executed* bundle instead would regress this chain's end block below what the pending bundle already recorded.
    expect(blockRanges[1]).to.deep.equal([pendingBundleEndBlocks[1], pendingBundleEndBlocks[1]]);
    expect(blockRanges[1][1]).to.be.at.least(executedBundleEndBlocks[1]);
  });

  it("freezes a disabled chain at the fully executed end block in non-optimistic mode", async function () {
    const spokeClients = stubSpokeClients({ [enabledChainId]: 1000 });
    const latestMainnetBlock = await hubPool.provider.getBlockNumber();

    const blockRanges = await getWidestPossibleExpectedBlockRange(
      chainIds,
      spokeClients,
      endBlockBuffers,
      { hubPoolClient, configStoreClient } as Clients,
      latestMainnetBlock,
      [enabledChainId],
      false // non-optimistic, i.e. how a bundle already in liveness is evaluated.
    );

    // Both chains reference the latest fully executed bundle, so the pending proposal is ignored on both branches.
    expect(blockRanges[0]).to.deep.equal([executedBundleEndBlocks[0] + 1, 1000]);
    expect(blockRanges[1]).to.deep.equal([executedBundleEndBlocks[1], executedBundleEndBlocks[1]]);
  });

  it("does not produce an inverted range when an enabled chain has not advanced past the pending proposal", async function () {
    // The enabled chain's head sits between the executed and the pending bundle end blocks.
    const spokeHeight = pendingBundleEndBlocks[0] - 10;
    expect(spokeHeight).to.be.greaterThan(executedBundleEndBlocks[0]);
    const spokeClients = stubSpokeClients({ [enabledChainId]: spokeHeight });
    const latestMainnetBlock = await hubPool.provider.getBlockNumber();

    const blockRanges = await getWidestPossibleExpectedBlockRange(
      chainIds,
      spokeClients,
      endBlockBuffers,
      { hubPoolClient, configStoreClient } as Clients,
      latestMainnetBlock,
      [enabledChainId],
      true // optimistic
    );

    // The chain is paused rather than given a start block above its end block.
    expect(blockRanges[0]).to.deep.equal([pendingBundleEndBlocks[0], pendingBundleEndBlocks[0]]);
    expect(blockRanges[0][0]).to.be.at.most(blockRanges[0][1]);
  });
});
