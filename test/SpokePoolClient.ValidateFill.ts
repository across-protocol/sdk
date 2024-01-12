import assert from "assert";
import { RelayData } from "../src/interfaces";
import { SpokePoolClient } from "../src/clients";
import {
  bnZero,
  bnOne,
  InvalidFill,
  relayFilledAmount,
  validateFillForDeposit,
  queryHistoricalDepositForFill,
} from "../src/utils";
import {
  expect,
  toBNWei,
  ethers,
  SignerWithAddress,
  deposit,
  setupTokensForWallet,
  toBN,
  buildFill,
  buildModifiedFill,
  deploySpokePoolWithToken,
  Contract,
  originChainId,
  destinationChainId,
  createSpyLogger,
  zeroAddress,
  deployAndConfigureHubPool,
  enableRoutesOnHubPool,
  deployConfigStore,
  getLastBlockTime,
  buildDeposit,
  assertPromiseError,
  getDepositParams,
  mineRandomBlocks,
  winston,
  lastSpyLogIncludes,
} from "./utils";
import { CHAIN_ID_TEST_LIST, repaymentChainId } from "./constants";
import { MockConfigStoreClient, MockHubPoolClient, MockSpokePoolClient } from "./mocks";

let spokePool_1: Contract, erc20_1: Contract, spokePool_2: Contract, erc20_2: Contract, hubPool: Contract;
let owner: SignerWithAddress, depositor: SignerWithAddress, relayer: SignerWithAddress;
let spokePool1DeploymentBlock: number, spokePool2DeploymentBlock: number;
let l1Token: Contract, configStore: Contract;
let spyLogger: winston.Logger;
// eslint-disable-next-line @typescript-eslint/no-unused-vars
let spy: sinon.SinonSpy;

let spokePoolClient2: SpokePoolClient, hubPoolClient: MockHubPoolClient;
let spokePoolClient1: SpokePoolClient, configStoreClient: MockConfigStoreClient;

describe("SpokePoolClient: Fill Validation", function () {
  beforeEach(async function () {
    [owner, depositor, relayer] = await ethers.getSigners();
    // Creat two spoke pools: one to act as the source and the other to act as the destination.
    ({
      spokePool: spokePool_1,
      erc20: erc20_1,
      deploymentBlock: spokePool1DeploymentBlock,
    } = await deploySpokePoolWithToken(originChainId, destinationChainId));
    ({
      spokePool: spokePool_2,
      erc20: erc20_2,
      deploymentBlock: spokePool2DeploymentBlock,
    } = await deploySpokePoolWithToken(destinationChainId, originChainId));
    ({ hubPool, l1Token_1: l1Token } = await deployAndConfigureHubPool(owner, [
      { l2ChainId: destinationChainId, spokePool: spokePool_2 },
      { l2ChainId: originChainId, spokePool: spokePool_1 },
      { l2ChainId: repaymentChainId, spokePool: spokePool_1 },
      { l2ChainId: 1, spokePool: spokePool_1 },
    ]));

    await enableRoutesOnHubPool(hubPool, [
      { destinationChainId: originChainId, l1Token, destinationToken: erc20_1 },
      { destinationChainId: destinationChainId, l1Token, destinationToken: erc20_2 },
    ]);

    ({ spy, spyLogger } = createSpyLogger());
    ({ configStore } = await deployConfigStore(owner, [l1Token]));

    configStoreClient = new MockConfigStoreClient(spyLogger, configStore, undefined, undefined, CHAIN_ID_TEST_LIST);
    await configStoreClient.update();

    hubPoolClient = new MockHubPoolClient(spyLogger, hubPool, configStoreClient);
    hubPoolClient.setTokenMapping(l1Token.address, originChainId, erc20_1.address);
    hubPoolClient.setTokenMapping(l1Token.address, destinationChainId, erc20_2.address);

    await hubPoolClient.update();
    spokePoolClient1 = new SpokePoolClient(
      spyLogger,
      spokePool_1,
      hubPoolClient,
      originChainId,
      spokePool1DeploymentBlock
    );
    spokePoolClient2 = new SpokePoolClient(
      createSpyLogger().spyLogger,
      spokePool_2,
      null,
      destinationChainId,
      spokePool2DeploymentBlock
    );

    await setupTokensForWallet(spokePool_1, depositor, [erc20_1], undefined, 10);
    await setupTokensForWallet(spokePool_2, relayer, [erc20_2], undefined, 10);

    // Set the spokePool's time to the provider time. This is done to enable the block utility time finder identify a
    // "reasonable" block number based off the block time when looking at quote timestamps. We only need to do
    // this on the deposit chain because that chain's spoke pool client will have to fill in its realized lp fee %.
    await spokePool_1.setCurrentTime(await getLastBlockTime(spokePool_1.provider));
  });

  it("Tracks fill status", async function () {
    const deposit = await buildDeposit(hubPoolClient, spokePool_1, erc20_1, depositor, destinationChainId);

    let filled = await relayFilledAmount(spokePool_2, deposit as RelayData);
    expect(filled.eq(0)).is.true;

    await buildFill(spokePool_2, erc20_2, depositor, relayer, deposit, 1);
    filled = await relayFilledAmount(spokePool_2, deposit as RelayData);
    expect(filled.eq(deposit.amount)).is.true;
  });

  it("Accepts valid fills", async function () {
    const deposit = await buildDeposit(hubPoolClient, spokePool_1, erc20_1, depositor, destinationChainId);
    await buildFill(spokePool_2, erc20_2, depositor, relayer, deposit, 1);

    await spokePoolClient2.update();
    await spokePoolClient1.update();

    const [deposit_1] = spokePoolClient1.getDeposits();
    const [fill_1] = spokePoolClient2.getFills();

    // Some fields are expected to be dynamically populated by the client, but aren't in this environment.
    // Populate them manually from the fill struct to get a valid comparison.
    const fill_2 = {
      ...deposit_1,
      realizedLpFeePct: fill_1.realizedLpFeePct,
      destinationToken: fill_1.destinationToken,
    };
    expect(validateFillForDeposit(fill_1, fill_2).valid).to.equal(true);
  });

  it("Returns deposit matched with fill", async function () {
    const deposit_1 = await buildDeposit(hubPoolClient, spokePool_1, erc20_1, depositor, destinationChainId);
    const fill_1 = await buildFill(spokePool_2, erc20_2, depositor, relayer, deposit_1, 0.5);
    const spokePoolClientForDestinationChain = new SpokePoolClient(
      createSpyLogger().spyLogger,
      spokePool_1,
      null,
      destinationChainId,
      spokePool1DeploymentBlock
    ); // create spoke pool client on the "target" chain.
    // expect(spokePoolClientForDestinationChain.getDepositForFill(fill_1)).to.equal(undefined);
    await spokePoolClientForDestinationChain.update();

    // Override the fill's realized LP fee % and destination token so that it matches the deposit's default zero'd
    // out values. The destination token and realized LP fee % are set by the spoke pool client by querying the hub pool
    // contract state, however this test ignores the rate model contract and therefore there is no hub pool contract
    // to query from, so they will be set to 0x0 and 0% respectively.
    const expectedDeposit = {
      ...deposit_1,
      destinationToken: zeroAddress,
      realizedLpFeePct: toBN(0),
    };
    expect(
      spokePoolClientForDestinationChain.getDepositForFill({
        ...fill_1,
        destinationToken: zeroAddress,
        realizedLpFeePct: toBN(0),
      })
    )
      .excludingEvery(["blockTimestamp", "logIndex", "transactionIndex", "transactionHash", "quoteBlockNumber"])
      .to.deep.equal(expectedDeposit);
  });

  it("Returns all fills that match deposit and fill", async function () {
    const deposit = await buildDeposit(hubPoolClient, spokePool_1, erc20_1, depositor, destinationChainId);
    const fill1 = await buildFill(spokePool_2, erc20_2, depositor, relayer, deposit, 0.5);
    let matchingFills = await spokePoolClient2.queryHistoricalMatchingFills(
      fill1,
      deposit,
      await spokePool_2.provider.getBlockNumber()
    );
    expect(matchingFills.length).to.equal(1);

    // Doesn't return any if fill isn't valid for deposit:
    matchingFills = await spokePoolClient2.queryHistoricalMatchingFills(
      fill1,
      { ...deposit, depositId: deposit.depositId + 1 },
      await spokePool_2.provider.getBlockNumber()
    );
    expect(matchingFills.length).to.equal(0);

    // Ignores fills for same depositor in block range that aren't valid for deposit:
    await buildFill(spokePool_2, erc20_2, depositor, relayer, { ...deposit, depositId: deposit.depositId + 1 }, 0.5);
    matchingFills = await spokePoolClient2.queryHistoricalMatchingFills(
      fill1,
      deposit,
      await spokePool_2.provider.getBlockNumber()
    );
    expect(matchingFills.length).to.equal(1);

    // Matches with second valid fill
    await buildFill(spokePool_2, erc20_2, depositor, relayer, deposit, 0.5);
    matchingFills = await spokePoolClient2.queryHistoricalMatchingFills(
      fill1,
      deposit,
      await spokePool_2.provider.getBlockNumber()
    );
    expect(matchingFills.length).to.equal(2);
  });

  it("Get search bounds for deposit ID", async function () {
    // @dev In this test we mine random counts of block between deposits to "fuzz" test the binary search algo
    // which can produce different results depending on the total search range and where deposit events fall.

    // Let's set the spoke pool client's isUpdated to true
    spokePoolClient1.isUpdated = true;

    // Send 2 deposits and mine blocks between them to ensure deposits are in different blocks.
    await deposit(spokePool_1, erc20_1, depositor, depositor, destinationChainId);
    await mineRandomBlocks();
    await deposit(spokePool_1, erc20_1, depositor, depositor, destinationChainId);
    await mineRandomBlocks();
    const [, deposit1Event] = await spokePool_1.queryFilter("FundsDeposited");
    const deposit1Block = deposit1Event.blockNumber;

    // Throws when low < high
    await assertPromiseError(
      spokePoolClient1._getBlockRangeForDepositId(0, 1, 0, 10),
      "Binary search failed because low > high"
    );

    // Set spoke pool client's latest to be the latest block so that the binary search defaults the "high" block
    // to this.
    spokePoolClient1.latestBlockSearched = await spokePool_1.provider.getBlockNumber();
    // Searching for deposit ID 0 with 10 max searches should return the block range that deposit ID 0 was mined in.
    // Note: the search range is inclusive, so the range should include the block that deposit ID 0 was mined in.
    const searchRange0 = await spokePoolClient1._getBlockRangeForDepositId(
      0,
      spokePool1DeploymentBlock,
      spokePoolClient1.latestBlockSearched,
      10
    );
    // The range should be within the spoke pool's deployment block and the latest block.
    // We can assume this because the binary search will always return a range that is within the search bounds.
    expect(searchRange0.low).to.greaterThanOrEqual(spokePool1DeploymentBlock);
    expect(searchRange0.high).to.lessThanOrEqual(spokePoolClient1.latestBlockSearched);

    // Searching for deposit ID 1 should also match invariants:
    // - range low <= correct block
    // - correct block <= range high
    // Where correct block is the block that the deposit ID incremented to the target.
    // So the correct block for deposit ID 1 is the block that deposit ID 0 was mined in.
    const searchRange1 = await spokePoolClient1._getBlockRangeForDepositId(
      1,
      spokePool1DeploymentBlock,
      spokePoolClient1.latestBlockSearched,
      10
    );

    expect(searchRange1.high).to.be.greaterThanOrEqual(deposit1Block);
    expect(searchRange1.low).to.be.lessThanOrEqual(deposit1Block);

    // Searching for deposit ID 2 that doesn't exist yet should throw.
    await assertPromiseError(
      spokePoolClient1._getBlockRangeForDepositId(
        2,
        spokePool1DeploymentBlock,
        spokePoolClient1.latestBlockSearched,
        10
      ),
      "Target depositId is greater than the initial high block"
    );

    // Searching for deposit ID -1 that doesn't exist should throw.
    await assertPromiseError(
      spokePoolClient1._getBlockRangeForDepositId(
        -1,
        spokePool1DeploymentBlock,
        spokePoolClient1.latestBlockSearched,
        10
      ),
      "Target depositId is less than the initial low block"
    );

    // Now send multiple deposits in the same block.
    const depositParams = getDepositParams({
      recipient: depositor.address,
      originToken: erc20_1.address,
      amount: toBNWei("1"),
      destinationChainId: destinationChainId,
      relayerFeePct: toBNWei("0.01"),
      quoteTimestamp: await spokePool_1.getCurrentTime(),
    });
    const depositData = await spokePool_1.populateTransaction.deposit(...depositParams);
    await spokePool_1.connect(depositor).multicall(Array(3).fill(depositData.data));
    expect(await spokePool_1.numberOfDeposits()).to.equal(5);
    const depositEvents = await spokePool_1.queryFilter("FundsDeposited");

    // Set fromBlock to block later than deposits.
    spokePoolClient1.latestBlockSearched = await spokePool_1.provider.getBlockNumber();

    // Check that ranges maintain invariants. These tests are interesting because SpokePool.numberOfDeposits()
    // will never equal any of the target IDs (e.g. 3,4,5) because multiple deposits were mined in the same block,
    // incrementing numberOfDeposits() atomically from 2 to 6.
    const searchRange3 = await spokePoolClient1._getBlockRangeForDepositId(
      3,
      spokePool1DeploymentBlock,
      spokePoolClient1.latestBlockSearched,
      10
    );
    const searchRange4 = await spokePoolClient1._getBlockRangeForDepositId(
      4,
      spokePool1DeploymentBlock,
      spokePoolClient1.latestBlockSearched,
      10
    );

    await assertPromiseError(
      spokePoolClient1._getBlockRangeForDepositId(
        5,
        spokePool1DeploymentBlock,
        spokePoolClient1.latestBlockSearched,
        10
      ),
      "Target depositId is greater than the initial high block"
    );

    expect(searchRange3.high).to.be.greaterThanOrEqual(depositEvents[2].blockNumber);
    expect(searchRange3.low).to.be.lessThanOrEqual(depositEvents[2].blockNumber);
    expect(searchRange4.high).to.be.greaterThanOrEqual(depositEvents[3].blockNumber);
    expect(searchRange4.low).to.be.lessThanOrEqual(depositEvents[3].blockNumber);
  });

  it("Fuzz: get search bounds for deposit ID", async function () {
    const fuzzClient = new MockSpokePoolClient(
      createSpyLogger().spyLogger,
      spokePool_2,
      destinationChainId,
      spokePool2DeploymentBlock
    );

    fuzzClient.isUpdated = true;

    const initLow = fuzzClient.deploymentBlock;
    const initHigh = 1000000;
    const depositIds = Array(initHigh + 1).fill(0);

    const testIterations = 1000;

    // Randomize deposit ID's between initLow and initHigh. ID's should only increase
    // and will do so 50% of the time. The other 50% of the time they will stay the same.
    // The increment will be between 0 and 10, to simulate sending multiple deposits in the same
    // block.
    for (let i = 1; i < depositIds.length; i++) {
      const increment = Math.max(0, Math.floor((Math.random() - 0.5) * 10));
      depositIds[i] = depositIds[i - 1] + increment;
    }
    fuzzClient.setDepositIds(depositIds);
    fuzzClient.setLatestBlockNumber(initHigh + 1);

    for (let i = 0; i < testIterations; i++) {
      // Randomize target between highest and lowest values in deposit IDs.
      const target = Math.floor(Math.random() * (depositIds[depositIds.length - 1] - initLow)) + initLow;

      // Randomize max # of searches.
      const maxSearches = Math.floor(Math.random() * 19) + 1;
      const results = await fuzzClient._getBlockRangeForDepositId(target, initLow, initHigh, maxSearches);

      // The "correct" block is the first block whose previous block's deposit ID is greater than
      // or equal to the target and whose deposit ID count is greater than the target.
      const correctBlock = depositIds.findIndex(
        (depositId, idx) => idx > 0 && target >= depositIds[idx - 1] && target < depositId
      );

      // Resolve the deposit number at the correct block.
      const startingInclusiveDepositIdAtCorrectBlock = depositIds[correctBlock - 1];
      const endingInclusiveDepositIdAtCorrectBlock = depositIds[correctBlock];

      // Resolve the true range of what our binary search should have returned.
      const startingInclusiveDepositIdAtLowRange = depositIds[results.low - 1];
      const endingInclusiveDepositIdAtHighRange = depositIds[results.high] - 1;

      // We should expect that the target is within the correct block's range
      // Note: this is a sanity check to ensure that our test is valid.
      expect(target >= startingInclusiveDepositIdAtCorrectBlock).to.be.true;
      expect(target <= endingInclusiveDepositIdAtCorrectBlock).to.be.true;

      // We should expect that the target is within the range returned by the binary search.
      expect(target >= startingInclusiveDepositIdAtLowRange).to.be.true;
      expect(target <= endingInclusiveDepositIdAtHighRange).to.be.true;

      // We should expect the correct block to be within the range returned by the binary search.
      expect(correctBlock >= results.low).to.be.true;
      expect(correctBlock <= results.high).to.be.true;

      // We should expect that our range is within the bounds of our initial range.
      expect(results.low >= initLow).to.be.true;
      expect(results.high <= initHigh).to.be.true;
    }
  });

  it("Can fetch older deposit matching fill", async function () {
    const deposit = await buildDeposit(hubPoolClient, spokePool_1, erc20_1, depositor, destinationChainId);
    await buildFill(spokePool_2, erc20_2, depositor, relayer, deposit, 1);
    await spokePoolClient2.update();
    const [fill] = spokePoolClient2.getFills();

    await assertPromiseError(queryHistoricalDepositForFill(spokePoolClient1, fill), "SpokePoolClient must be updated");

    // Set event search config from block to latest block so client doesn't see event.
    spokePoolClient1.eventSearchConfig.fromBlock = await spokePool_1.provider.getBlockNumber();
    spokePoolClient1.firstBlockToSearch = spokePoolClient1.eventSearchConfig.fromBlock;
    await spokePoolClient1.update();

    // Client has 0 deposits in memory so querying historical deposit sends fresh RPC requests.
    expect(spokePoolClient1.getDeposits().length).to.equal(0);

    const historicalDeposit = await queryHistoricalDepositForFill(spokePoolClient1, fill);
    assert(historicalDeposit.found === true, "Test is broken"); // Help tsc to narrow the discriminated union.
    expect(historicalDeposit.deposit.depositId).to.deep.equal(deposit.depositId);
  });

  it("Can fetch younger deposit matching fill", async function () {
    const deposit = await buildDeposit(hubPoolClient, spokePool_1, erc20_1, depositor, destinationChainId);
    const depositBlock = await spokePool_1.provider.getBlockNumber();
    await buildFill(spokePool_2, erc20_2, depositor, relayer, deposit, 1);
    await spokePoolClient2.update();
    const [fill] = spokePoolClient2.getFills();

    await assertPromiseError(queryHistoricalDepositForFill(spokePoolClient1, fill), "SpokePoolClient must be updated");

    // Set event search config to block to before deposit so client doesn't see event.
    spokePoolClient1.eventSearchConfig.toBlock = depositBlock - 1;
    await spokePoolClient1.update();

    // Make sure that the client's latestBlockSearched encompasses the event so it can see it on the subsequent
    // queryHistoricalDepositForFill call.
    spokePoolClient1.latestBlockSearched = depositBlock;

    // Client has 0 deposits in memory so querying historical deposit sends fresh RPC requests.
    expect(spokePoolClient1.getDeposits().length).to.equal(0);

    const historicalDeposit = await queryHistoricalDepositForFill(spokePoolClient1, fill);
    assert(historicalDeposit.found === true, "Test is broken"); // Help tsc to narrow the discriminated union.
    expect(historicalDeposit.deposit.depositId).to.deep.equal(deposit.depositId);
  });

  it("Loads fills from memory with deposit ID > spoke pool client's earliest deposit ID queried", async function () {
    const deposit = await buildDeposit(hubPoolClient, spokePool_1, erc20_1, depositor, destinationChainId);
    const fill = await buildFill(spokePool_2, erc20_2, depositor, relayer, deposit, 1);
    await spokePoolClient1.update();
    expect(spokePoolClient1.earliestDepositIdQueried == 0).is.true;

    // Client should NOT send RPC requests to fetch this deposit, instead it should load from memory.
    expect((await queryHistoricalDepositForFill(spokePoolClient1, fill)).found).is.true;
    expect(lastSpyLogIncludes(spy, "updated!")).is.true;

    // Now override earliest deposit ID queried so that its > deposit ID and check that client sends RPC requests.
    spokePoolClient1.earliestDepositIdQueried = 1;
    expect((await queryHistoricalDepositForFill(spokePoolClient1, fill)).found).is.true;
    expect(lastSpyLogIncludes(spy, "Located deposit outside of SpokePoolClient's search range")).is.true;
  });

  it("Loads fills from memory with deposit ID < spoke pool client's latest deposit ID queried", async function () {
    // Send fill for deposit ID 0.
    const deposit = await buildDeposit(hubPoolClient, spokePool_1, erc20_1, depositor, destinationChainId);
    const fill = await buildFill(spokePool_2, erc20_2, depositor, relayer, deposit, 1);
    await spokePoolClient1.update();
    // Manually override latest deposit ID queried so that its > deposit ID.
    spokePoolClient1.latestDepositIdQueried = 1;

    // Client should NOT send RPC requests to fetch this deposit, instead it should load from memory.
    expect((await queryHistoricalDepositForFill(spokePoolClient1, fill)).found).is.true;
    expect(lastSpyLogIncludes(spy, "updated!")).is.true;

    // Now override latest deposit ID queried so that its < deposit ID and check that client sends RPC requests.
    spokePoolClient1.latestDepositIdQueried = -1;
    expect((await queryHistoricalDepositForFill(spokePoolClient1, fill)).found).is.true;
    expect(lastSpyLogIncludes(spy, "Located deposit outside of SpokePoolClient's search range")).is.true;
  });

  it("Ignores fills with deposit ID < first deposit ID in spoke pool", async function () {
    const deposit = await buildDeposit(hubPoolClient, spokePool_1, erc20_1, depositor, destinationChainId);
    await buildFill(spokePool_2, erc20_2, depositor, relayer, deposit, 1);
    await spokePoolClient2.update();
    const [fill] = spokePoolClient2.getFills();

    // Override the first spoke pool deposit ID that the client thinks is available in the contract.
    await spokePoolClient1.update();
    spokePoolClient1.firstDepositIdForSpokePool = deposit.depositId + 1;
    expect(fill.depositId < spokePoolClient1.firstDepositIdForSpokePool).is.true;
    const search = await queryHistoricalDepositForFill(spokePoolClient1, fill);

    assert(search.found === false, "Test is broken"); // Help tsc to narrow the discriminated union.
    expect(search.code).to.equal(InvalidFill.DepositIdInvalid);
    expect(lastSpyLogIncludes(spy, "Queried RPC for deposit")).is.not.true;
  });

  it("Ignores fills with deposit ID > latest deposit ID in spoke pool", async function () {
    const sampleDeposit = await buildDeposit(hubPoolClient, spokePool_1, erc20_1, depositor, destinationChainId);
    // Override the deposit ID that we are "filling" to be > 1, the latest deposit ID in spoke pool 1.
    await buildFill(
      spokePool_2,
      erc20_2,
      depositor,
      relayer,
      {
        ...sampleDeposit,
        depositId: 2,
      },
      1
    );
    await spokePoolClient2.update();
    const [fill] = spokePoolClient2.getFills();

    await spokePoolClient1.update();
    expect(fill.depositId > spokePoolClient1.lastDepositIdForSpokePool).is.true;
    const search = await queryHistoricalDepositForFill(spokePoolClient1, fill);

    assert(search.found === false, "Test is broken"); // Help tsc to narrow the discriminated union.
    expect(search.code).to.equal(InvalidFill.DepositIdInvalid);
    expect(lastSpyLogIncludes(spy, "Queried RPC for deposit")).is.not.true;
  });

  it("Ignores matching fills that mis-specify a deposit attribute", async function () {
    const deposit = await buildDeposit(hubPoolClient, spokePool_1, erc20_1, depositor, destinationChainId);

    deposit.realizedLpFeePct = (deposit.realizedLpFeePct ?? bnZero).add(bnOne);
    const fill = await buildFill(spokePool_2, erc20_2, depositor, relayer, deposit, 1);

    await Promise.all([spokePoolClient1.update(), spokePoolClient2.update()]);

    const search = await queryHistoricalDepositForFill(spokePoolClient1, fill);
    assert(search.found === false, "Test is broken"); // Help tsc to narrow the discriminated union.
    expect(search.code).to.equal(InvalidFill.FillMismatch);
  });

  it("Returns sped up deposit matched with fill", async function () {
    const deposit_1 = await buildDeposit(hubPoolClient, spokePool_1, erc20_1, depositor, destinationChainId);
    // Override the fill's realized LP fee % and destination token so that it matches the deposit's default zero'd
    // out values. The destination token and realized LP fee % are set by the spoke pool client by querying the hub pool
    // contract state, however this test ignores the rate model contract and therefore there is no hub pool contract
    // to query from, so they will be set to 0x0 and 0% respectively.
    const expectedDeposit = {
      ...deposit_1,
      destinationToken: zeroAddress,
      realizedLpFeePct: toBN(0),
    };
    const fill_1 = await buildFill(spokePool_2, erc20_2, depositor, relayer, expectedDeposit, 0.2);
    const fill_2 = await buildModifiedFill(spokePool_2, depositor, relayer, fill_1, 2, 0.2, relayer.address, "0x12"); // Fill same % of deposit with 2x larger relayer fee pct.

    const spokePoolClientForDestinationChain = new SpokePoolClient(
      createSpyLogger().spyLogger,
      spokePool_1,
      null,
      destinationChainId,
      spokePool2DeploymentBlock
    ); // create spoke pool client on the "target" chain.
    await spokePoolClientForDestinationChain.update();

    // Sanity Check: Ensure that fill2 is defined
    expect(fill_2).to.not.be.undefined;
    if (!fill_2) {
      throw new Error("fill_2 is undefined");
    }

    expect(fill_2.updatableRelayData.recipient === relayer.address).to.be.true;
    expect(fill_1.updatableRelayData.recipient === depositor.address).to.be.true;
    expect(fill_2.updatableRelayData.message === "0x12").to.be.true;
    expect(fill_1.updatableRelayData.message === "0x").to.be.true;
    expect(fill_1.updatableRelayData.relayerFeePct.eq(fill_2.updatableRelayData.relayerFeePct)).to.be.false;
    expect(fill_1.updatableRelayData.isSlowRelay === fill_2.updatableRelayData.isSlowRelay).to.be.true;
    expect(fill_1.updatableRelayData.payoutAdjustmentPct.eq(fill_2.updatableRelayData.payoutAdjustmentPct)).to.be.true;

    expect(
      spokePoolClientForDestinationChain.getDepositForFill({
        ...fill_1,
        destinationToken: zeroAddress,
        realizedLpFeePct: toBN(0),
      })
    )
      .excludingEvery(["blockTimestamp", "logIndex", "transactionIndex", "transactionHash", "quoteBlockNumber"])
      .to.deep.equal(expectedDeposit);
    expect(
      spokePoolClientForDestinationChain.getDepositForFill({
        ...fill_2,
        destinationToken: zeroAddress,
        realizedLpFeePct: toBN(0),
      })
    ).excludingEvery(["blockTimestamp", "logIndex", "transactionIndex", "transactionHash", "quoteBlockNumber"]);
    const deposit = await buildDeposit(hubPoolClient, spokePool_1, erc20_1, depositor, destinationChainId);
    await buildFill(spokePool_2, erc20_2, depositor, relayer, deposit, 1);

    await spokePoolClient2.update();
    await spokePoolClient1.update();

    const [incompleteDeposit] = spokePoolClient1.getDeposits();
    const [validFill] = spokePoolClient2.getFills();
    const validDeposit = {
      ...incompleteDeposit,
      realizedLpFeePct: validFill.realizedLpFeePct,
      destinationToken: validFill.destinationToken,
    };

    // Invalid Amount.
    expect(validateFillForDeposit({ ...validFill, amount: toBNWei(1337) }, validDeposit).valid).to.be.false;

    // Invalid depositId.
    expect(validateFillForDeposit({ ...validFill, depositId: 1337 }, validDeposit).valid).to.be.false;

    // Changed the depositor.
    expect(validateFillForDeposit({ ...validFill, depositor: relayer.address }, validDeposit).valid).to.be.false;

    // Changed the recipient.
    expect(validateFillForDeposit({ ...validFill, recipient: relayer.address }, validDeposit).valid).to.be.false;

    // Changed the relayerFeePct.
    expect(validateFillForDeposit({ ...validFill, relayerFeePct: toBNWei(1337) }, validDeposit).valid).to.be.false;

    // Validate the realizedLPFeePct and destinationToken matches. These values are optional in the deposit object and
    // are assigned during the update method, which is not polled in this set of tests.

    // Assign a realizedLPFeePct to the deposit and check it matches with the fill. After, try changing this to a
    // separate value and ensure this is rejected.
    expect(
      validateFillForDeposit(validFill, {
        ...validDeposit,
        realizedLpFeePct: validFill.realizedLpFeePct,
      }).valid
    ).to.be.true;

    expect(
      validateFillForDeposit(validFill, {
        ...validDeposit,
        realizedLpFeePct: validFill.realizedLpFeePct.add(toBNWei("0.1")),
      }).valid
    ).to.be.false;

    // Assign a destinationToken to the deposit and ensure it is validated correctly. erc20_2 from the fillRelay method
    // above is the destination token. After, try changing this to something that is clearly wrong.
    expect(validateFillForDeposit(validFill, { ...validDeposit, destinationToken: erc20_2.address }).valid).to.be.true;
    expect(validateFillForDeposit(validFill, { ...validDeposit, destinationToken: owner.address }).valid).to.be.false;
  });
});
