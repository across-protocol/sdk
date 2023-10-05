import {
  CONFIG_STORE_VERSION,
  randomDestinationToken,
  randomDestinationToken2,
  randomL1Token,
  randomOriginToken,
} from "./constants";
import { MockConfigStoreClient, MockHubPoolClient } from "./mocks";
import {
  Contract,
  SignerWithAddress,
  createRandomBytes32,
  createSpyLogger,
  deployConfigStore,
  destinationChainId,
  ethers,
  expect,
  getContractFactory,
  originChainId,
  toBN,
  zeroAddress,
} from "./utils";

let hubPool: Contract, lpTokenFactory: Contract, mockAdapter: Contract;
let owner: SignerWithAddress;
let hubPoolClient: MockHubPoolClient;

describe("HubPoolClient: Deposit to Destination Token", function () {
  // Helper function to process another validated bundle. Returns the block height
  // at which the bundle was validated.
  async function validateAnotherBundle(chains: number[], bundleEndBlock: number): Promise<number> {
    const rootBundleProposal = hubPoolClient.proposeRootBundle(
      Date.now(), // challengePeriodEndTimestamp
      chains.length, // poolRebalanceLeafCount
      chains.map(() => toBN(bundleEndBlock)),
      createRandomBytes32() // Random pool rebalance root we can check.
    );
    hubPoolClient.addEvent(rootBundleProposal);
    await hubPoolClient.update();
    let lastBlockNumber = 0;
    chains.forEach((chainId, leafIndex) => {
      const leafEvent = hubPoolClient.executeRootBundle(
        toBN(0),
        leafIndex,
        toBN(chainId),
        [], // l1Tokens
        [], // bundleLpFees
        [], // netSendAmounts
        [] // runningBalances
      );
      hubPoolClient.addEvent(leafEvent);
      lastBlockNumber = Math.max(leafEvent.blockNumber, lastBlockNumber);
    });
    await hubPoolClient.update();
    return lastBlockNumber;
  }
  beforeEach(async function () {
    [owner] = await ethers.getSigners();

    // Deploy minimal hubPool. Don't configure the finder, timer or weth addresses as unrelated for this test file.
    lpTokenFactory = await (await getContractFactory("LpTokenFactory", owner)).deploy();
    hubPool = await (
      await getContractFactory("HubPool", owner)
    ).deploy(lpTokenFactory.address, zeroAddress, zeroAddress, zeroAddress);

    mockAdapter = await (await getContractFactory("Mock_Adapter", owner)).deploy();
    await hubPool.setCrossChainContracts(originChainId, mockAdapter.address, zeroAddress);

    const logger = createSpyLogger().spyLogger;
    const { configStore } = await deployConfigStore(owner, []);
    const configStoreClient = new MockConfigStoreClient(logger, configStore, { fromBlock: 0 }, CONFIG_STORE_VERSION);
    await configStoreClient.update();

    hubPoolClient = new MockHubPoolClient(logger, hubPool, configStoreClient);
    await hubPoolClient.update();
  });

  it("Gets L2 token counterpart", async function () {
    expect(() => hubPoolClient.getL2TokenForL1TokenAtBlock(randomL1Token, destinationChainId, 0)).to.throw(
      /Could not find L2 token mapping/
    );
    const e1 = await hubPoolClient.setPoolRebalanceRoute(destinationChainId, randomL1Token, randomDestinationToken);
    hubPoolClient.addEvent(e1);
    await hubPoolClient.update();

    // If input hub pool block is before all events, should throw.
    expect(() => hubPoolClient.getL2TokenForL1TokenAtBlock(randomL1Token, destinationChainId, 0)).to.throw(
      /Could not find L2 token mapping/
    );
    expect(hubPoolClient.getL2TokenForL1TokenAtBlock(randomL1Token, destinationChainId, e1.blockNumber)).to.equal(
      randomDestinationToken
    );

    // Now try changing the destination token. Client should correctly handle this.
    const e2 = await hubPoolClient.setPoolRebalanceRoute(destinationChainId, randomL1Token, randomDestinationToken2);
    hubPoolClient.addEvent(e2);
    await hubPoolClient.update();

    expect(hubPoolClient.getL2TokenForL1TokenAtBlock(randomL1Token, destinationChainId, e2.blockNumber)).to.equal(
      randomDestinationToken2
    );
    expect(hubPoolClient.getL2TokenForL1TokenAtBlock(randomL1Token, destinationChainId, e1.blockNumber)).to.equal(
      randomDestinationToken
    );
  });
  it("Gets L1 token counterpart", async function () {
    expect(() => hubPoolClient.getL1TokenForL2TokenAtBlock(randomDestinationToken, destinationChainId, 0)).to.throw(
      /Could not find L1 token mapping/
    );
    const e1 = await hubPoolClient.setPoolRebalanceRoute(destinationChainId, randomL1Token, randomDestinationToken);
    hubPoolClient.addEvent(e1);
    await hubPoolClient.update();

    // If input hub pool block is before all events, should throw.
    expect(() => hubPoolClient.getL1TokenForL2TokenAtBlock(randomDestinationToken, destinationChainId, 0)).to.throw(
      /Could not find L1 token mapping/
    );
    expect(
      hubPoolClient.getL1TokenForL2TokenAtBlock(randomDestinationToken, destinationChainId, e1.blockNumber)
    ).to.equal(randomL1Token);

    // Now try changing the L1 token while keeping destination chain and L2 token the same.
    const e2 = await hubPoolClient.setPoolRebalanceRoute(destinationChainId, randomOriginToken, randomDestinationToken);
    hubPoolClient.addEvent(e2);
    await hubPoolClient.update();

    expect(
      hubPoolClient.getL1TokenForL2TokenAtBlock(randomDestinationToken, destinationChainId, e2.blockNumber)
    ).to.equal(randomOriginToken);
    expect(
      hubPoolClient.getL1TokenForL2TokenAtBlock(randomDestinationToken, destinationChainId, e1.blockNumber)
    ).to.equal(randomL1Token);

    // If L2 token mapping doesn't exist, throw.
    expect(() => hubPoolClient.getL1TokenForL2TokenAtBlock(randomL1Token, destinationChainId, e2.blockNumber)).to.throw(
      /Could not find L1 token mapping/
    );
    expect(() =>
      hubPoolClient.getL1TokenForL2TokenAtBlock(randomDestinationToken, originChainId, e2.blockNumber)
    ).to.throw(/Could not find L1 token mapping/);
  });
  it("Gets L1 token for deposit", async function () {
    // Setup
    // - Deposited token on originChainId has its L1 token mapping switched from randomL1Token to randomOriginToken
    const e0 = await hubPoolClient.setPoolRebalanceRoute(originChainId, randomL1Token, randomDestinationToken);
    const e1 = await hubPoolClient.setPoolRebalanceRoute(originChainId, randomOriginToken, randomDestinationToken);
    hubPoolClient.addEvent(e0);
    hubPoolClient.addEvent(e1);
    await hubPoolClient.update();

    const depositData = {
      originChainId,
      originToken: randomDestinationToken,
      blockNumber: e1.blockNumber,
    };

    // No validated bundles before the deposit, so return latest route.
    expect(hubPoolClient.getMainnetConfigBlockForEvent(depositData.blockNumber, depositData.originChainId)).to.equal(0);
    expect(hubPoolClient.getL1TokenForDeposit(depositData)).to.equal(randomOriginToken);

    // Now validate a bundle, and then update the route.
    const validatedBlock1 = await validateAnotherBundle([originChainId], e1.blockNumber);

    // Add another route for the same deposited token.
    const e2 = await hubPoolClient.setPoolRebalanceRoute(originChainId, randomDestinationToken, randomDestinationToken);
    hubPoolClient.addEvent(e2);
    await hubPoolClient.update();

    // The L1 token fetched for a deposit event following the bundle should use the
    // event before the bundle.
    expect(hubPoolClient.getMainnetConfigBlockForEvent(validatedBlock1, depositData.originChainId)).to.equal(
      e1.blockNumber
    );
    expect(hubPoolClient.getL1TokenForDeposit({ ...depositData, blockNumber: validatedBlock1 })).to.equal(
      randomOriginToken
    );

    // The L1 token fetched for a deposit before the bundle should still use the latest event as of the
    // deposit quote block.
    expect(hubPoolClient.getL1TokenForDeposit(depositData)).to.equal(randomOriginToken);

    // Validate one more bundle and check that the route has updated to e2.
    const validatedBlock2 = await validateAnotherBundle([originChainId], e2.blockNumber);
    expect(hubPoolClient.getMainnetConfigBlockForEvent(validatedBlock2, depositData.originChainId)).to.equal(
      e2.blockNumber
    );
    expect(hubPoolClient.getL1TokenForDeposit({ ...depositData, blockNumber: validatedBlock2 })).to.equal(
      randomDestinationToken
    );
  });
  it("Gets L2 token for deposit", async function () {
    // Setup
    // - Deposited token on originChainId is switched to route to randomOriginToken from randomDestinationToken
    const e0 = await hubPoolClient.setPoolRebalanceRoute(originChainId, randomL1Token, randomOriginToken);
    const e1 = await hubPoolClient.setPoolRebalanceRoute(originChainId, randomL1Token, randomDestinationToken);
    const e2 = await hubPoolClient.setPoolRebalanceRoute(destinationChainId, randomL1Token, randomL1Token);
    hubPoolClient.addEvent(e0);
    hubPoolClient.addEvent(e1);
    hubPoolClient.addEvent(e2);
    await hubPoolClient.update();

    const depositData = {
      originChainId,
      originToken: randomDestinationToken,
      blockNumber: e1.blockNumber,
    };

    // No validated bundles before the deposit, so return latest route.
    expect(hubPoolClient.getMainnetConfigBlockForEvent(depositData.blockNumber, depositData.originChainId)).to.equal(0);
    expect(hubPoolClient.getL2TokenForDeposit(originChainId, depositData)).to.equal(randomDestinationToken);

    // Now validate a bundle, and then update the route.
    const validatedBlock1 = await validateAnotherBundle([originChainId, destinationChainId], e2.blockNumber);

    // Update the route after validating the bundle.
    const e3 = await hubPoolClient.setPoolRebalanceRoute(originChainId, randomL1Token, randomL1Token);
    hubPoolClient.addEvent(e3);
    await hubPoolClient.update();

    // The L2 token fetched for a deposit event following the bundle should use the
    // event before the bundle.
    expect(hubPoolClient.getMainnetConfigBlockForEvent(validatedBlock1, depositData.originChainId)).to.equal(
      e2.blockNumber
    );
    expect(
      hubPoolClient.getL2TokenForDeposit(originChainId, { ...depositData, blockNumber: validatedBlock1 })
    ).to.equal(randomDestinationToken);
    expect(() =>
      hubPoolClient.getL1TokenForDeposit({
        ...depositData,
        originToken: randomL1Token,
        blockNumber: validatedBlock1,
      })
    ).to.throw(/Could not find L1 token mapping/);

    // If we validate another bundle, then the L2 token should be updated.
    const validatedBlock2 = await validateAnotherBundle([originChainId, destinationChainId], e3.blockNumber);
    expect(hubPoolClient.getMainnetConfigBlockForEvent(validatedBlock2, depositData.originChainId)).to.equal(
      e3.blockNumber
    );
    expect(
      hubPoolClient.getL2TokenForDeposit(originChainId, {
        ...depositData,
        originToken: randomL1Token,
        blockNumber: validatedBlock2,
      })
    ).to.equal(randomL1Token);
  });
  it("Get mainnet config for deposit event", async function () {
    await hubPoolClient.update();
    // No bundles containing chain, returns 0 which is the next bundle's mainnet start block.
    expect(hubPoolClient.getMainnetConfigBlockForEvent(0, 1, [1, 2, 3])).to.equal(0);

    // Add a bundle:
    await validateAnotherBundle([1, 2, 3], 100);
    // If the bundle contains the block for the chain (i.e. end block of 100 contains block [0, 100]), return the
    // latest validated mainnet end block.
    expect(hubPoolClient.getMainnetConfigBlockForEvent(0, 1, [1, 2, 3])).to.equal(0);
    expect(hubPoolClient.getMainnetConfigBlockForEvent(10, 1, [1, 2, 3])).to.equal(0);
    expect(hubPoolClient.getMainnetConfigBlockForEvent(100, 1, [1, 2, 3])).to.equal(0);

    // Bundle does not contain any block for chain 9, so return the latest validated mainnet end block.
    expect(hubPoolClient.getMainnetConfigBlockForEvent(0, 9, [1, 2, 3])).to.equal(100);
    expect(hubPoolClient.getMainnetConfigBlockForEvent(10, 9, [1, 2, 3])).to.equal(100);
    expect(hubPoolClient.getMainnetConfigBlockForEvent(100, 9, [1, 2, 3])).to.equal(100);
    expect(hubPoolClient.getMainnetConfigBlockForEvent(101, 9, [1, 2, 3])).to.equal(100);

    // There is no bundle containing block 101 on chain 1, so return the latest validated mainnet end block.
    expect(hubPoolClient.getMainnetConfigBlockForEvent(101, 1, [1, 2, 3])).to.equal(100);

    // Add a bundle:
    await validateAnotherBundle([1, 2, 3], 200);

    // Now, any block for a chain in [1,2,3] between [101, 200] should return 100
    expect(hubPoolClient.getMainnetConfigBlockForEvent(101, 1, [1, 2, 3])).to.equal(100);
    expect(hubPoolClient.getMainnetConfigBlockForEvent(110, 1, [1, 2, 3])).to.equal(100);
    expect(hubPoolClient.getMainnetConfigBlockForEvent(200, 1, [1, 2, 3])).to.equal(100);

    // Block [0, 100] should still return 0
    expect(hubPoolClient.getMainnetConfigBlockForEvent(0, 1, [1, 2, 3])).to.equal(0);
    expect(hubPoolClient.getMainnetConfigBlockForEvent(100, 1, [1, 2, 3])).to.equal(0);

    // Any block for chain [1,2,3] above 200 should return 200
    expect(hubPoolClient.getMainnetConfigBlockForEvent(201, 1, [1, 2, 3])).to.equal(200);

    // Bundle does not contain any block for chain 9, so return the latest validated mainnet end block.
    expect(hubPoolClient.getMainnetConfigBlockForEvent(0, 9, [1, 2, 3])).to.equal(200);
    expect(hubPoolClient.getMainnetConfigBlockForEvent(10, 9, [1, 2, 3])).to.equal(200);
    expect(hubPoolClient.getMainnetConfigBlockForEvent(100, 9, [1, 2, 3])).to.equal(200);
    expect(hubPoolClient.getMainnetConfigBlockForEvent(101, 9, [1, 2, 3])).to.equal(200);
    expect(hubPoolClient.getMainnetConfigBlockForEvent(200, 9, [1, 2, 3])).to.equal(200);
    expect(hubPoolClient.getMainnetConfigBlockForEvent(201, 9, [1, 2, 3])).to.equal(200);
  });
});
