/* eslint-disable @typescript-eslint/no-non-null-assertion */
import hre from "hardhat";
import { AcrossConfigStoreClient as ConfigStoreClient, HubPoolClient } from "../src/clients";
import { ProposedRootBundle } from "../src/interfaces";
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
  randomAddress,
  toBN,
  toBNWei,
  winston,
} from "./utils";
import { setupHubPool } from "./fixtures/HubPool.Fixture";
import { EvmAddress, toAddressType } from "../src/utils";

let hubPool: Contract, timer: Contract;
let l1Token_1: Contract, l1Token_2: Contract;
let dataworker: SignerWithAddress, owner: SignerWithAddress;
let logger: winston.Logger;

let hubPoolClient: HubPoolClient;
let configStoreClient: ConfigStoreClient;

async function constructSimpleTree(runningBalance: BigNumber) {
  const netSendAmount = runningBalance.mul(toBN(-1));
  const bundleLpFees = toBNWei(1);
  const leaves = buildPoolRebalanceLeaves(
    [constants.originChainId, constants.destinationChainId], // Where funds are getting sent.
    [[l1Token_1.address, l1Token_2.address], [l1Token_2.address]], // l1Token.
    [[bundleLpFees, bundleLpFees.mul(toBN(2))], [bundleLpFees.mul(toBN(2))]], // bundleLpFees.
    [[netSendAmount, netSendAmount.mul(toBN(2))], [netSendAmount.mul(toBN(2))]], // netSendAmounts.
    [[runningBalance, runningBalance.mul(toBN(2))], [runningBalance.mul(toBN(3))]], // runningBalances.
    [0, 0] // groupId. Doesn't matter for this test.
  );

  const tree = await buildPoolRebalanceLeafTree(leaves);
  return { leaves, tree };
}

describe("HubPoolClient: RootBundle Events", function () {
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
  });

  it("gets ProposeRootBundle event containing correct bundle block eval number", async function () {
    const { tree, leaves } = await constructSimpleTree(toBNWei(100));

    await configStoreClient.update();
    await hubPoolClient.update();
    expect(hubPoolClient.hasPendingProposal()).to.equal(false);

    const liveness = Number(await hubPool.liveness());
    const proposeTime = Number(await hubPool.getCurrentTime());
    const txn = await hubPool
      .connect(dataworker)
      .proposeRootBundle([11, 22], 2, tree.getHexRoot(), constants.mockTreeRoot, constants.mockTreeRoot);
    const proposalBlockNumber = (await txn.wait()).blockNumber;

    // Pre update returns undefined.
    expect(
      hubPoolClient.getRootBundleEvalBlockNumberContainingBlock(await hubPool.provider.getBlockNumber(), 22, 2, [1, 2])
    ).to.equal(undefined);
    await hubPoolClient.update();

    expect(hubPoolClient.getPendingRootBundle()).to.deep.equal({
      poolRebalanceRoot: tree.getHexRoot(),
      relayerRefundRoot: constants.mockTreeRoot,
      slowRelayRoot: constants.mockTreeRoot,
      proposer: toAddressType(dataworker.address, hubPoolClient.chainId),
      unclaimedPoolRebalanceLeafCount: 2,
      challengePeriodEndTimestamp: proposeTime + liveness,
      bundleEvaluationBlockNumbers: [11, 22],
      proposalBlockNumber,
    });
    expect(hubPoolClient.hasPendingProposal()).to.equal(true);

    // Ignores root bundles that aren't full executed.
    expect(
      hubPoolClient.getRootBundleEvalBlockNumberContainingBlock(await hubPool.provider.getBlockNumber(), 22, 2, [1, 2])
    ).to.equal(undefined);

    // Happy case where `chainIdList` contains chain ID and block is <= than the bundle block range for that chain.
    await timer.connect(dataworker).setCurrentTime(proposeTime + liveness + 1);
    await hubPool.connect(dataworker).executeRootBundle(...Object.values(leaves[0]), tree.getHexProof(leaves[0]));
    await hubPool.connect(dataworker).executeRootBundle(...Object.values(leaves[1]), tree.getHexProof(leaves[1]));
    await hubPoolClient.update();
    expect(
      hubPoolClient.getRootBundleEvalBlockNumberContainingBlock(await hubPool.provider.getBlockNumber(), 22, 2, [1, 2])
    ).to.equal(22);

    // `block` is greater than bundle block number for the chain.
    expect(
      hubPoolClient.getRootBundleEvalBlockNumberContainingBlock(await hubPool.provider.getBlockNumber(), 23, 2, [1, 2])
    ).to.equal(undefined);

    // Chain ID list doesn't contain `chain`
    expect(
      hubPoolClient.getRootBundleEvalBlockNumberContainingBlock(await hubPool.provider.getBlockNumber(), 22, 2, [1, 3])
    ).to.equal(undefined);

    // Chain ID list length doesn't match bundle block range length
    expect(
      hubPoolClient.getRootBundleEvalBlockNumberContainingBlock(await hubPool.provider.getBlockNumber(), 22, 2, [1])
    ).to.equal(undefined);

    // latestMainnetBlock is before leaves are executed, so client doesn't know that bundle was validated.
    expect(hubPoolClient.getRootBundleEvalBlockNumberContainingBlock(1, 22, 2, [1, 2])).to.equal(undefined);

    // If we propose a new root bundle, then `getRootBundleEvalBlockNumberContainingBlock` throws away the
    // `latestMainnetBlock` param and just searches for executed leaves until the next bundle.
    await hubPool
      .connect(dataworker)
      .proposeRootBundle([12, 23], 2, tree.getHexRoot(), constants.mockTreeRoot, constants.mockTreeRoot);
    await hubPoolClient.update();
    expect(hubPoolClient.getRootBundleEvalBlockNumberContainingBlock(1, 22, 2, [1, 2])).to.equal(22);
  });

  it("Returns validated root bundle", async function () {
    const { tree, leaves } = await constructSimpleTree(toBNWei(100));

    await configStoreClient.update();
    await hubPoolClient.update();
    expect(hubPoolClient.hasPendingProposal()).to.equal(false);

    const liveness = Number(await hubPool.liveness());
    const proposeTime = Number(await hubPool.getCurrentTime());
    const txn = await hubPool
      .connect(dataworker)
      .proposeRootBundle([11, 22], 2, tree.getHexRoot(), constants.mockTreeRoot, constants.mockTreeRoot);

    // Not valid because not executed.
    const rootBundle: ProposedRootBundle = {
      poolRebalanceRoot: tree.getHexRoot(),
      relayerRefundRoot: constants.mockTreeRoot,
      slowRelayRoot: constants.mockTreeRoot,
      proposer: EvmAddress.from(dataworker.address),
      poolRebalanceLeafCount: 2,
      challengePeriodEndTimestamp: proposeTime + liveness,
      bundleEvaluationBlockNumbers: [toBN(11), toBN(22)],
      blockNumber: (await txn.wait()).blockNumber,
      txnIndex: 0,
      logIndex: 0,
      txnRef: "",
    };
    expect(hubPoolClient.isRootBundleValid(rootBundle, hubPoolClient.latestHeightSearched!)).to.equal(false);

    // Execute leaves.
    await timer.connect(dataworker).setCurrentTime(proposeTime + liveness + 1);
    await hubPool.connect(dataworker).executeRootBundle(...Object.values(leaves[0]), tree.getHexProof(leaves[0]));

    // Not valid until all leaves are executed.
    await hubPoolClient.update();
    expect(hubPoolClient.isRootBundleValid(rootBundle, hubPoolClient.latestHeightSearched!)).to.equal(false);
    const blockNumberBeforeAllLeavesExecuted = hubPoolClient.latestHeightSearched;

    await hubPool.connect(dataworker).executeRootBundle(...Object.values(leaves[1]), tree.getHexProof(leaves[1]));
    await hubPoolClient.update();
    expect(hubPoolClient.isRootBundleValid(rootBundle, hubPoolClient.latestHeightSearched!)).to.equal(true);

    // Only searches for executed leaves up to input latest mainnet block to search
    expect(hubPoolClient.isRootBundleValid(rootBundle, blockNumberBeforeAllLeavesExecuted!)).to.equal(false);
  });

  it("gets most recent RootBundleExecuted event for chainID and L1 token", async function () {
    const { tree: tree1, leaves: leaves1 } = await constructSimpleTree(toBNWei(100));
    const { tree: tree2, leaves: leaves2 } = await constructSimpleTree(toBNWei(200));
    let runningBalance: BigNumber;

    await configStoreClient.update();
    await hubPoolClient.update();

    // Propose one root bundle with two leaves for two different L2 chains.
    await hubPool
      .connect(dataworker)
      .proposeRootBundle([11, 22], 2, tree1.getHexRoot(), constants.mockTreeRoot, constants.mockTreeRoot);
    await timer.setCurrentTime(Number(await timer.getCurrentTime()) + constants.refundProposalLiveness + 1);
    await hubPool.connect(dataworker).executeRootBundle(...Object.values(leaves1[0]), tree1.getHexProof(leaves1[0]));
    await hubPool.connect(dataworker).executeRootBundle(...Object.values(leaves1[1]), tree1.getHexProof(leaves1[1]));
    const firstRootBundleBlockNumber = await hubPool.provider.getBlockNumber();

    ({ runningBalance } = hubPoolClient.getRunningBalanceBeforeBlockForChain(
      firstRootBundleBlockNumber,
      constants.originChainId,
      EvmAddress.from(l1Token_1.address)
    ));
    expect(runningBalance.eq(0)).to.be.true;
    await hubPoolClient.update();

    // Happy case where client returns most recent running balance for chain ID and l1 token.
    ({ runningBalance } = hubPoolClient.getRunningBalanceBeforeBlockForChain(
      firstRootBundleBlockNumber,
      constants.originChainId,
      EvmAddress.from(l1Token_1.address)
    ));
    expect(runningBalance.eq(toBNWei(100))).to.be.true;

    // Target block is before event.
    ({ runningBalance } = hubPoolClient.getRunningBalanceBeforeBlockForChain(
      0,
      constants.originChainId,
      EvmAddress.from(l1Token_1.address)
    ));
    expect(runningBalance.eq(0)).to.be.true;

    // chain ID and L1 token combination not found.
    ({ runningBalance } = hubPoolClient.getRunningBalanceBeforeBlockForChain(
      firstRootBundleBlockNumber,
      constants.destinationChainId,
      EvmAddress.from(l1Token_1.address)
    ));
    expect(runningBalance.eq(0)).to.be.true;

    ({ runningBalance } = hubPoolClient.getRunningBalanceBeforeBlockForChain(
      firstRootBundleBlockNumber,
      constants.originChainId,
      EvmAddress.from(timer.address)
    ));
    expect(runningBalance.eq(0)).to.be.true;

    // Running balance at index of L1 token returned:
    ({ runningBalance } = hubPoolClient.getRunningBalanceBeforeBlockForChain(
      firstRootBundleBlockNumber,
      constants.originChainId,
      EvmAddress.from(l1Token_2.address)
    ));
    expect(runningBalance.eq(toBNWei(200))).to.be.true;

    // Propose and execute another root bundle:
    await hubPool
      .connect(dataworker)
      .proposeRootBundle([11, 22], 2, tree2.getHexRoot(), constants.mockTreeRoot, constants.mockTreeRoot);
    await timer.setCurrentTime(Number(await timer.getCurrentTime()) + constants.refundProposalLiveness + 1);
    await hubPool.connect(dataworker).executeRootBundle(...Object.values(leaves2[0]), tree2.getHexProof(leaves2[0]));
    await hubPool.connect(dataworker).executeRootBundle(...Object.values(leaves2[1]), tree2.getHexProof(leaves2[1]));
    const secondRootBundleBlockNumber = await hubPool.provider.getBlockNumber();
    await hubPoolClient.update();

    // Grabs most up to date running balance for block:
    ({ runningBalance } = hubPoolClient.getRunningBalanceBeforeBlockForChain(
      secondRootBundleBlockNumber,
      constants.originChainId,
      EvmAddress.from(l1Token_1.address)
    ));
    expect(runningBalance.eq(toBNWei(200))).to.be.true; // Grabs second running balance

    ({ runningBalance } = hubPoolClient.getRunningBalanceBeforeBlockForChain(
      firstRootBundleBlockNumber,
      constants.originChainId,
      EvmAddress.from(l1Token_1.address)
    ));
    expect(runningBalance.eq(toBNWei(100))).to.be.true; // Grabs first running balance
  });

  it("returns proposed and disputed bundles", async function () {
    const { tree: tree1 } = await constructSimpleTree(toBNWei(100));

    await configStoreClient.update();
    await hubPoolClient.update();

    // Propose one root bundle with a chain ID list length of 1
    const bundleBlockEvalNumbers = [11];
    await hubPool
      .connect(dataworker)
      .proposeRootBundle(bundleBlockEvalNumbers, 1, tree1.getHexRoot(), constants.mockTreeRoot, constants.mockTreeRoot);

    await hubPoolClient.update();
    expect(hubPoolClient.getProposedRootBundles()[0].proposer.toEvmAddress()).to.equal(dataworker.address);
    expect(hubPoolClient.getDisputedRootBundles().length).to.equal(0);

    await hubPool.connect(dataworker).disputeRootBundle();
    await hubPoolClient.update();
    expect(hubPoolClient.getDisputedRootBundles()[0].disputer).to.equal(dataworker.address);
  });

  it("returns next root bundle start block", async function () {
    const { tree: tree1, leaves: leaves1 } = await constructSimpleTree(toBNWei(100));
    const { tree: tree2, leaves: leaves2 } = await constructSimpleTree(toBNWei(100));

    await configStoreClient.update();
    await hubPoolClient.update();

    // Propose one root bundle with a chain ID list length of 1
    const bundleBlockEvalNumbers = [11];
    const firstChainIdList = [leaves1[0].chainId.toNumber()];
    await hubPool
      .connect(dataworker)
      .proposeRootBundle(bundleBlockEvalNumbers, 1, tree1.getHexRoot(), constants.mockTreeRoot, constants.mockTreeRoot);
    const proposalBlockNumber = await hubPool.provider.getBlockNumber();

    // Mine blocks so proposal and execution are at different blocks, so we can test what happens if either is not
    // found.
    await hre.network.provider.send("evm_mine");
    await hre.network.provider.send("evm_mine");
    await hre.network.provider.send("evm_mine");

    // Don't execute the leaves yet. This should make the function return 0 as the start block since it
    // ignores proposed root bundles that are not fully executed.
    await timer.setCurrentTime(Number(await timer.getCurrentTime()) + constants.refundProposalLiveness + 1);
    const partialExecutionBlockNumber = await hubPool.provider.getBlockNumber();

    // No fully executed pool rebalance roots.
    await hubPoolClient.update();
    expect(
      hubPoolClient.getNextBundleStartBlockNumber(firstChainIdList, partialExecutionBlockNumber, firstChainIdList[0])
    ).to.equal(0);

    // Pool rebalance root is fully executed, returns block number based on fully executed root bundle at the latest
    // mainnet block passed in.
    await hubPool.connect(dataworker).executeRootBundle(...Object.values(leaves1[0]), tree1.getHexProof(leaves1[0]));
    const executionBlockNumber = await hubPool.provider.getBlockNumber();
    await hubPoolClient.update();
    expect(
      hubPoolClient.getNextBundleStartBlockNumber(firstChainIdList, executionBlockNumber, firstChainIdList[0])
    ).to.equal(bundleBlockEvalNumbers[0] + 1);

    // Chain that doesn't exist in chain ID list returns 0
    expect(hubPoolClient.getNextBundleStartBlockNumber(firstChainIdList, executionBlockNumber, 999)).to.equal(0);

    // Chain that does exist in chain ID list but at an index that doesn't exist in bundle block range list returns 0.
    // In this case, the root bundle event's bundle list contains 1 chain, and we're looking up the chain matching the
    // second index.
    expect(hubPoolClient.getNextBundleStartBlockNumber([...firstChainIdList, 999], executionBlockNumber, 999)).to.equal(
      0
    );

    // Mine more blocks and Propose and execute another root bundle:
    await hre.network.provider.send("evm_mine");
    await hre.network.provider.send("evm_mine");
    await hre.network.provider.send("evm_mine");

    // This time, create a bundle with a chain ID list length of 2.
    const secondBundleBlockEvalNumbers = [66, 77];
    const secondChainIdList = [leaves1[0].chainId.toNumber(), leaves1[1].chainId.toNumber()];
    await hubPool
      .connect(dataworker)
      .proposeRootBundle([66, 77], 2, tree2.getHexRoot(), constants.mockTreeRoot, constants.mockTreeRoot);
    await timer.setCurrentTime(Number(await timer.getCurrentTime()) + constants.refundProposalLiveness + 1);
    await hubPool.connect(dataworker).executeRootBundle(...Object.values(leaves2[0]), tree2.getHexProof(leaves2[0]));
    await hubPool.connect(dataworker).executeRootBundle(...Object.values(leaves2[1]), tree2.getHexProof(leaves2[1]));
    const secondExecutionBlockNumber = await hubPool.provider.getBlockNumber();

    // When client is unaware of latest events pre-update, returns block from first update.
    expect(
      hubPoolClient.getNextBundleStartBlockNumber(secondChainIdList, secondExecutionBlockNumber, secondChainIdList[0])
    ).to.equal(bundleBlockEvalNumbers[0] + 1);
    await hubPoolClient.update();

    // Happy case, latest block is equal to or greater than execution block number, returns bundle eval block + 1
    // for chain at correct index.
    expect(
      hubPoolClient.getNextBundleStartBlockNumber(secondChainIdList, secondExecutionBlockNumber, secondChainIdList[0])
    ).to.equal(secondBundleBlockEvalNumbers[0] + 1);
    expect(
      hubPoolClient.getNextBundleStartBlockNumber(secondChainIdList, secondExecutionBlockNumber, secondChainIdList[1])
    ).to.equal(secondBundleBlockEvalNumbers[1] + 1);

    // Passing in older block returns older end block
    expect(
      hubPoolClient.getNextBundleStartBlockNumber(secondChainIdList, executionBlockNumber, secondChainIdList[0])
    ).to.equal(bundleBlockEvalNumbers[0] + 1);

    // No ExecuteRootBundle events before block.
    expect(
      hubPoolClient.getNextBundleStartBlockNumber(secondChainIdList, proposalBlockNumber, secondChainIdList[0])
    ).to.equal(0);

    // No ProposeRootBundle events before block.
    expect(hubPoolClient.getNextBundleStartBlockNumber(secondChainIdList, 0, secondChainIdList[0])).to.equal(0);
  });

  it("gets most recent CrossChainContractsSet event for chainID", async function () {
    const adapter = randomAddress();
    const spokePool1 = randomAddress();
    const spokePool2 = randomAddress();
    await hubPool.connect(owner).setCrossChainContracts([11], adapter, spokePool1);
    const firstUpdateBlockNumber = await hubPool.provider.getBlockNumber();
    await hre.network.provider.send("evm_mine");
    await hre.network.provider.send("evm_mine");
    await hre.network.provider.send("evm_mine");
    await hubPool.connect(owner).setCrossChainContracts([11], adapter, spokePool2);
    const secondUpdateBlockNumber = await hubPool.provider.getBlockNumber();

    // Default case when there are no events for a chain.
    expect(() => hubPoolClient.getSpokePoolForBlock(11, firstUpdateBlockNumber)).to.throw(
      /No cross chain contracts set/
    );
    await configStoreClient.update();
    await hubPoolClient.update();

    // Happy case where latest spoke pool at block is returned
    expect(hubPoolClient.getSpokePoolForBlock(11, firstUpdateBlockNumber).toNative()).to.equal(spokePool1);
    expect(hubPoolClient.getSpokePoolForBlock(11, secondUpdateBlockNumber).toNative()).to.equal(spokePool2);

    // Chain has events but none before block
    expect(() => hubPoolClient.getSpokePoolForBlock(11, firstUpdateBlockNumber - 1)).to.throw(
      /No cross chain contract found before block/
    );
  });
});
