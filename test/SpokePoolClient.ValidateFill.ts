import { DepositWithBlock, FillStatus, FillType } from "../src/interfaces";
import { SpokePoolClient } from "../src/clients";
import {
  bnOne,
  bnZero,
  toBN,
  InvalidFill,
  fillStatusArray,
  relayFillStatus,
  validateFillForDeposit,
  queryHistoricalDepositForFill,
  DepositSearchResult,
  getBlockRangeForDepositId,
} from "../src/utils";
import { ZERO_BYTES } from "../src/constants";
import { CHAIN_ID_TEST_LIST, originChainId, destinationChainId, repaymentChainId } from "./constants";
import {
  assert,
  expect,
  BigNumber,
  toBNWei,
  ethers,
  SignerWithAddress,
  depositV3,
  fillV3Relay,
  requestV3SlowFill,
  setupTokensForWallet,
  deploySpokePoolWithToken,
  Contract,
  createSpyLogger,
  deployAndConfigureHubPool,
  enableRoutesOnHubPool,
  deployConfigStore,
  getLastBlockTime,
  assertPromiseError,
  getDepositParams,
  mineRandomBlocks,
  winston,
  lastSpyLogIncludes,
} from "./utils";
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
  let inputToken: string, outputToken: string;
  let inputAmount: BigNumber, outputAmount: BigNumber;

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

    inputToken = erc20_1.address;
    inputAmount = toBNWei(1);
    outputToken = erc20_2.address;
    outputAmount = inputAmount.sub(bnOne);
  });

  it("Correctly matches fills with deposits", async function () {
    const deposit_2 = await depositV3(
      spokePool_1,
      destinationChainId,
      depositor,
      inputToken,
      inputAmount,
      outputToken,
      outputAmount
    );
    const fill = await fillV3Relay(spokePool_2, deposit_2, relayer);
    await spokePoolClient2.update();

    expect(validateFillForDeposit(fill, deposit_2)).to.deep.equal({ valid: true });

    const ignoredFields = [
      "fromLiteChain",
      "toLiteChain",
      "blockNumber",
      "transactionHash",
      "transactionIndex",
      "logIndex",
      "relayer",
      "repaymentChainId",
      "relayExecutionInfo",
      "message",
    ];

    // For each RelayData field, toggle the value to produce an invalid fill. Verify that it's rejected.
    const fields = Object.keys(fill).filter((field) => !ignoredFields.includes(field));
    for (const field of fields) {
      let val: BigNumber | string | number;
      if (BigNumber.isBigNumber(fill[field])) {
        val = fill[field].add(bnOne);
      } else if (typeof fill[field] === "string") {
        val = fill[field] + "1234";
      } else {
        expect(typeof fill[field]).to.equal("number");
        val = fill[field] + 1;
      }

      const result = validateFillForDeposit(fill, { ...deposit_2, [field]: val });
      expect(result.valid).to.be.false;
      expect((result as { reason: string }).reason.startsWith(`${field} mismatch`)).to.be.true;
    }

    // Verify that the underlying fill is untouched and still valid.
    expect(validateFillForDeposit(fill, deposit_2)).to.deep.equal({ valid: true });
  });

  it("Tracks v3 fill status", async function () {
    const deposit = await depositV3(
      spokePool_1,
      destinationChainId,
      depositor,
      inputToken,
      inputAmount,
      outputToken,
      outputAmount
    );

    let filled = await relayFillStatus(spokePool_2, deposit);
    expect(filled).to.equal(FillStatus.Unfilled);

    // Also test spoke client variant
    filled = await spokePoolClient2.relayFillStatus(deposit);
    expect(filled).to.equal(FillStatus.Unfilled);

    await fillV3Relay(spokePool_2, deposit, relayer);
    filled = await relayFillStatus(spokePool_2, deposit);
    expect(filled).to.equal(FillStatus.Filled);

    // Also test spoke client variant
    filled = await spokePoolClient2.relayFillStatus(deposit);
    expect(filled).to.equal(FillStatus.Filled);
  });

  it("Tracks bulk v3 fill status", async function () {
    const deposits: DepositWithBlock[] = [];

    for (let i = 0; i < 5; ++i) {
      const deposit = await depositV3(
        spokePool_1,
        destinationChainId,
        depositor,
        inputToken,
        inputAmount,
        outputToken,
        outputAmount
      );
      deposits.push(deposit);
    }
    expect(deposits.length).to.be.greaterThan(0);

    let fills = await fillStatusArray(spokePool_2, deposits);
    expect(fills.length).to.equal(deposits.length);
    fills.forEach((fillStatus) => expect(fillStatus).to.equal(FillStatus.Unfilled));

    // Fill the first deposit and verify that the status updates correctly.
    await fillV3Relay(spokePool_2, deposits[0], relayer);
    fills = await fillStatusArray(spokePool_2, deposits);
    expect(fills.length).to.equal(deposits.length);
    expect(fills[0]).to.equal(FillStatus.Filled);
    fills.slice(1).forEach((fillStatus) => expect(fillStatus).to.equal(FillStatus.Unfilled));

    // Request a slow fill on the second deposit and verify that the status updates correctly.
    await spokePool_2.setCurrentTime(deposits[1].exclusivityDeadline + 1);
    await requestV3SlowFill(spokePool_2, deposits[1], relayer);
    fills = await fillStatusArray(spokePool_2, deposits);
    expect(fills.length).to.equal(deposits.length);
    expect(fills[0]).to.equal(FillStatus.Filled);
    expect(fills[1]).to.equal(FillStatus.RequestedSlowFill);
    fills.slice(2).forEach((fillStatus) => expect(fillStatus).to.equal(FillStatus.Unfilled));

    // Fill all outstanding deposits and verify that the status updates correctly.
    await Promise.all(deposits.slice(1).map((deposit) => fillV3Relay(spokePool_2, deposit, relayer)));
    fills = await fillStatusArray(spokePool_2, deposits);
    expect(fills.length).to.equal(deposits.length);
    fills.forEach((fillStatus) => expect(fillStatus).to.equal(FillStatus.Filled));
  });

  it("Accepts valid fills", async function () {
    const deposit = await depositV3(
      spokePool_1,
      destinationChainId,
      depositor,
      inputToken,
      inputAmount,
      outputToken,
      outputAmount
    );
    await fillV3Relay(spokePool_2, deposit, relayer);

    await spokePoolClient2.update();
    await spokePoolClient1.update();

    const [deposit_1] = spokePoolClient1.getDeposits();
    const [fill_1] = spokePoolClient2.getFills();

    // Some fields are expected to be dynamically populated by the client, but aren't in this environment.
    // Fill them in manually from the fill struct to get a valid comparison.
    expect(validateFillForDeposit(fill_1, deposit_1)).to.deep.equal({ valid: true });
  });

  it("Returns deposit matched with fill", async function () {
    const _deposit = await depositV3(
      spokePool_1,
      destinationChainId,
      depositor,
      inputToken,
      inputAmount,
      outputToken,
      outputAmount
    );

    const fill = await fillV3Relay(spokePool_2, _deposit, relayer);
    expect(spokePoolClient2.getDepositForFill(fill)).to.equal(undefined);
    await spokePoolClient1.update();

    const deposit = spokePoolClient1.getDepositForFill(fill);
    expect(deposit).to.exist;

    expect(spokePoolClient1.getDepositForFill(fill))
      .excludingEvery(["quoteBlockNumber", "fromLiteChain", "toLiteChain", "message"])
      .to.deep.equal(deposit);
  });

  it("Get search bounds for deposit ID", async function () {
    // @dev In this test we mine random counts of block between deposits to "fuzz" test the binary search algo
    // which can produce different results depending on the total search range and where deposit events fall.

    // Let's set the spoke pool client's isUpdated to true
    spokePoolClient1.isUpdated = true;

    // Send 2 deposits and mine blocks between them to ensure deposits are in different blocks.
    await depositV3(spokePool_1, destinationChainId, depositor, inputToken, inputAmount, outputToken, outputAmount);
    await mineRandomBlocks();

    const { blockNumber: deposit1Block } = await depositV3(
      spokePool_1,
      destinationChainId,
      depositor,
      inputToken,
      inputAmount,
      outputToken,
      outputAmount
    );
    await mineRandomBlocks();

    const [, deposit1Event] = await spokePool_1.queryFilter("FundsDeposited");
    const deposit1Block = deposit1Event.blockNumber;

    // Throws when low < high
    await assertPromiseError(
      getBlockRangeForDepositId(bnZero, 1, 0, 10, spokePoolClient1),
      "Binary search failed because low > high"
    );

    // Set spoke pool client's latest to be the latest block so that the binary search defaults the "high" block
    // to this.
    spokePoolClient1.latestBlockSearched = await spokePool_1.provider.getBlockNumber();
    // Searching for deposit ID 0 with 10 max searches should return the block range that deposit ID 0 was mined in.
    // Note: the search range is inclusive, so the range should include the block that deposit ID 0 was mined in.
    const searchRange0 = await getBlockRangeForDepositId(
      bnZero,
      spokePool1DeploymentBlock,
      spokePoolClient1.latestBlockSearched,
      10,
      spokePoolClient1
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
    const searchRange1 = await getBlockRangeForDepositId(
      bnOne,
      spokePool1DeploymentBlock,
      spokePoolClient1.latestBlockSearched,
      10,
      spokePoolClient1
    );

    expect(searchRange1.high).to.be.greaterThanOrEqual(deposit1Block);
    expect(searchRange1.low).to.be.lessThanOrEqual(deposit1Block);

    // Searching for deposit ID 2 that doesn't exist yet should throw.
    await assertPromiseError(
      getBlockRangeForDepositId(
        toBN(2),
        spokePool1DeploymentBlock,
        spokePoolClient1.latestBlockSearched,
        10,
        spokePoolClient1
      ),
      "Target depositId is greater than the initial high block"
    );

    // Searching for deposit ID -1 that doesn't exist should throw.
    await assertPromiseError(
      getBlockRangeForDepositId(
        toBN(-1),
        spokePool1DeploymentBlock,
        spokePoolClient1.latestBlockSearched,
        10,
        spokePoolClient1
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
    const depositData = await spokePool_1.populateTransaction.depositDeprecated_5947912356(...depositParams);
    await spokePool_1.connect(depositor).multicall(Array(3).fill(depositData.data));
    expect(await spokePool_1.numberOfDeposits()).to.equal(5);
    const depositEvents = await spokePool_1.queryFilter("FundsDeposited");

    // Set fromBlock to block later than deposits.
    spokePoolClient1.latestBlockSearched = await spokePool_1.provider.getBlockNumber();

    // Check that ranges maintain invariants. These tests are interesting because SpokePool.numberOfDeposits()
    // will never equal any of the target IDs (e.g. 3,4,5) because multiple deposits were mined in the same block,
    // incrementing numberOfDeposits() atomically from 2 to 6.
    const searchRange3 = await getBlockRangeForDepositId(
      toBN(3),
      spokePool1DeploymentBlock,
      spokePoolClient1.latestBlockSearched,
      10,
      spokePoolClient1
    );
    const searchRange4 = await getBlockRangeForDepositId(
      toBN(4),
      spokePool1DeploymentBlock,
      spokePoolClient1.latestBlockSearched,
      10,
      spokePoolClient1
    );

    await assertPromiseError(
      getBlockRangeForDepositId(
        toBN(5),
        spokePool1DeploymentBlock,
        spokePoolClient1.latestBlockSearched,
        10,
        spokePoolClient1
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
    fuzzClient.setDepositIds(depositIds.map(toBN));
    fuzzClient.setLatestBlockNumber(initHigh + 1);

    for (let i = 0; i < testIterations; i++) {
      // Randomize target between highest and lowest values in deposit IDs.
      const target = Math.floor(Math.random() * (depositIds[depositIds.length - 1] - initLow)) + initLow;

      // Randomize max # of searches.
      const maxSearches = Math.floor(Math.random() * 19) + 1;
      const results = await getBlockRangeForDepositId(toBN(target), initLow, initHigh, maxSearches, fuzzClient);

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
    const deposit = await depositV3(
      spokePool_1,
      destinationChainId,
      depositor,
      inputToken,
      inputAmount,
      outputToken,
      outputAmount
    );
    await fillV3Relay(spokePool_2, deposit, relayer);
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
    assert.equal(historicalDeposit.found, true, "Test is broken"); // Help tsc to narrow the discriminated union.
    expect((historicalDeposit as Extract<DepositSearchResult, { found: true }>).deposit.depositId).to.deep.equal(
      deposit.depositId
    );
  });

  it("Can fetch younger deposit matching fill", async function () {
    const deposit = await depositV3(
      spokePool_1,
      destinationChainId,
      depositor,
      inputToken,
      inputAmount,
      outputToken,
      outputAmount
    );
    const { blockNumber: depositBlock } = deposit;

    await fillV3Relay(spokePool_2, deposit, relayer);
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
    assert.equal(historicalDeposit.found, true, "Test is broken"); // Help tsc to narrow the discriminated union.
    expect((historicalDeposit as Extract<DepositSearchResult, { found: true }>).deposit.depositId).to.deep.equal(
      deposit.depositId
    );
  });

  it("Loads fills from memory with deposit ID > spoke pool client's earliest deposit ID queried", async function () {
    const deposit = await depositV3(
      spokePool_1,
      destinationChainId,
      depositor,
      inputToken,
      inputAmount,
      outputToken,
      outputAmount
    );
    const fill = await fillV3Relay(spokePool_2, deposit, relayer);
    await spokePoolClient1.update();
    expect(spokePoolClient1.earliestDepositIdQueried == 0).is.true;

    // Client should NOT send RPC requests to fetch this deposit, instead it should load from memory.
    expect((await queryHistoricalDepositForFill(spokePoolClient1, fill)).found).is.true;
    expect(lastSpyLogIncludes(spy, "updated!")).is.true;

    // Now override earliest deposit ID queried so that its > deposit ID and check that client sends RPC requests.
    spokePoolClient1.earliestDepositIdQueried = 1;
    expect((await queryHistoricalDepositForFill(spokePoolClient1, fill)).found).is.true;
    expect(lastSpyLogIncludes(spy, "Located V3 deposit outside of SpokePoolClient's search range")).is.true;
  });

  it("Loads fills from memory with deposit ID < spoke pool client's latest deposit ID queried", async function () {
    // Send fill for deposit ID 0.
    const deposit = await depositV3(
      spokePool_1,
      destinationChainId,
      depositor,
      inputToken,
      inputAmount,
      outputToken,
      outputAmount
    );
    const fill = await fillV3Relay(spokePool_2, deposit, relayer);
    await spokePoolClient1.update();
    // Manually override latest deposit ID queried so that its > deposit ID.
    spokePoolClient1.latestDepositIdQueried = 1;

    // Client should NOT send RPC requests to fetch this deposit, instead it should load from memory.
    expect((await queryHistoricalDepositForFill(spokePoolClient1, fill)).found).is.true;
    expect(lastSpyLogIncludes(spy, "updated!")).is.true;

    // Now override latest deposit ID queried so that its < deposit ID and check that client sends RPC requests.
    spokePoolClient1.latestDepositIdQueried = -1;
    expect((await queryHistoricalDepositForFill(spokePoolClient1, fill)).found).is.true;
    expect(lastSpyLogIncludes(spy, "Located V3 deposit outside of SpokePoolClient's search range")).is.true;
  });

  it("Ignores fills with deposit ID < first deposit ID in spoke pool", async function () {
    const deposit = await depositV3(
      spokePool_1,
      destinationChainId,
      depositor,
      inputToken,
      inputAmount,
      outputToken,
      outputAmount
    );
    await fillV3Relay(spokePool_2, deposit, relayer);
    await spokePoolClient2.update();
    const [fill] = spokePoolClient2.getFills();

    // Override the first spoke pool deposit ID that the client thinks is available in the contract.
    await spokePoolClient1.update();
    spokePoolClient1.firstDepositIdForSpokePool = deposit.depositId.add(1);
    expect(fill.depositId < spokePoolClient1.firstDepositIdForSpokePool).is.true;
    const search = await queryHistoricalDepositForFill(spokePoolClient1, fill);

    assert.equal(search.found, false, "Test is broken"); // Help tsc to narrow the discriminated union.
    expect((search as Extract<DepositSearchResult, { found: false }>).code).to.equal(InvalidFill.DepositIdInvalid);
    expect(lastSpyLogIncludes(spy, "Queried RPC for deposit")).is.not.true;
  });

  it("Ignores fills with deposit ID > latest deposit ID in spoke pool", async function () {
    const deposit = await depositV3(
      spokePool_1,
      destinationChainId,
      depositor,
      inputToken,
      inputAmount,
      outputToken,
      outputAmount
    );

    // Override the deposit ID that we are "filling" to be > 1, the latest deposit ID in spoke pool 1.
    await fillV3Relay(spokePool_2, { ...deposit, depositId: deposit.depositId.add(1) }, relayer);
    await spokePoolClient2.update();
    const [fill] = spokePoolClient2.getFills();

    await spokePoolClient1.update();
    expect(fill.depositId > spokePoolClient1.lastDepositIdForSpokePool).is.true;
    const search = await queryHistoricalDepositForFill(spokePoolClient1, fill);

    assert.equal(search.found, false, "Test is broken"); // Help tsc to narrow the discriminated union.
    expect((search as Extract<DepositSearchResult, { found: false }>).code).to.equal(InvalidFill.DepositIdInvalid);
    expect(lastSpyLogIncludes(spy, "Queried RPC for deposit")).is.not.true;
  });

  it("Ignores matching fills that mis-specify a deposit attribute", async function () {
    const deposit = await depositV3(
      spokePool_1,
      destinationChainId,
      depositor,
      inputToken,
      inputAmount,
      outputToken,
      outputAmount
    );

    deposit.outputAmount = deposit.outputAmount.sub(bnOne);
    const fill = await fillV3Relay(spokePool_2, deposit, relayer);

    await Promise.all([spokePoolClient1.update(), spokePoolClient2.update()]);

    const search = await queryHistoricalDepositForFill(spokePoolClient1, fill);
    assert.equal(search.found, false, "Test is broken"); // Help tsc to narrow the discriminated union.
    expect((search as Extract<DepositSearchResult, { found: false }>).code).to.equal(InvalidFill.FillMismatch);
  });

  it("Returns sped up deposit matched with fill", async function () {
    const _deposit_1 = await depositV3(
      spokePool_1,
      destinationChainId,
      depositor,
      inputToken,
      inputAmount,
      outputToken,
      outputAmount
    );
    await spokePoolClient1.update();

    const fill_1 = await fillV3Relay(spokePool_2, _deposit_1, relayer);
    const fill_2 = await fillV3Relay(
      spokePool_2,
      {
        ..._deposit_1,
        recipient: relayer.address,
        outputAmount: _deposit_1.outputAmount.div(2),
        message: "0x12",
      },
      relayer
    );

    // Sanity Check: Ensure that fill2 is defined
    expect(fill_2).to.not.be.undefined;
    if (!fill_2) {
      throw new Error("fill_2 is undefined");
    }

    expect(fill_1.relayExecutionInfo.updatedRecipient === depositor.address).to.be.true;
    expect(fill_2.relayExecutionInfo.updatedRecipient === relayer.address).to.be.true;
    expect(fill_2.relayExecutionInfo.updatedMessageHash === ethers.utils.keccak256("0x12")).to.be.true;
    expect(fill_1.relayExecutionInfo.updatedMessageHash === ZERO_BYTES).to.be.true;
    expect(fill_1.relayExecutionInfo.updatedOutputAmount.eq(fill_2.relayExecutionInfo.updatedOutputAmount)).to.be.false;
    expect(fill_1.relayExecutionInfo.fillType === FillType.FastFill).to.be.true;
    expect(fill_2.relayExecutionInfo.fillType === FillType.FastFill).to.be.true;

    const deposit = spokePoolClient1.getDepositForFill(fill_1);
    expect(deposit).to.exist;
    let result = validateFillForDeposit(fill_1, deposit);
    expect(result.valid).to.be.true;
    expect(spokePoolClient1.getDepositForFill(fill_2)).to.equal(undefined);

    const _deposit_2 = await depositV3(
      spokePool_1,
      destinationChainId,
      depositor,
      inputToken,
      inputAmount,
      outputToken,
      outputAmount
    );
    const fill = await fillV3Relay(spokePool_2, _deposit_2, relayer);
    await spokePoolClient2.update();

    expect(validateFillForDeposit(fill, _deposit_2)).to.deep.equal({ valid: true });

    // Changed the input token.
    result = validateFillForDeposit(fill, { ..._deposit_2, inputToken: owner.address });
    expect(result.valid).to.be.false;
    expect((result as { reason: string }).reason.startsWith("inputToken mismatch")).to.be.true;

    // Invalid input amount.
    result = validateFillForDeposit({ ...fill, inputAmount: toBNWei(1337) }, _deposit_2);
    expect(result.valid).to.be.false;
    expect((result as { reason: string }).reason.startsWith("inputAmount mismatch")).to.be.true;

    // Changed the output token.
    result = validateFillForDeposit(fill, { ..._deposit_2, outputToken: owner.address });
    expect(result.valid).to.be.false;
    expect((result as { reason: string }).reason.startsWith("outputToken mismatch")).to.be.true;

    // Changed the output amount.
    result = validateFillForDeposit({ ...fill, outputAmount: toBNWei(1337) }, _deposit_2);
    expect(result.valid).to.be.false;
    expect((result as { reason: string }).reason.startsWith("outputAmount mismatch")).to.be.true;

    // Invalid depositId.
    result = validateFillForDeposit({ ...fill, depositId: toBN(1337) }, _deposit_2);
    expect(result.valid).to.be.false;
    expect((result as { reason: string }).reason.startsWith("depositId mismatch")).to.be.true;

    // Changed the depositor.
    result = validateFillForDeposit({ ...fill, depositor: relayer.address }, _deposit_2);
    expect(result.valid).to.be.false;
    expect((result as { reason: string }).reason.startsWith("depositor mismatch")).to.be.true;

    // Changed the recipient.
    result = validateFillForDeposit({ ...fill, recipient: relayer.address }, _deposit_2);
    expect(result.valid).to.be.false;
    expect((result as { reason: string }).reason.startsWith("recipient mismatch")).to.be.true;
  });
});
