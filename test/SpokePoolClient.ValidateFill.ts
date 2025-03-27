import hre from "hardhat";
import { DepositWithBlock, FillStatus, FillType } from "../src/interfaces";
import { EVMSpokePoolClient, SpokePoolClient } from "../src/clients";
import {
  bnOne,
  bnZero,
  toBN,
  InvalidFill,
  fillStatusArray,
  relayFillStatus,
  validateFillForDeposit,
  queryHistoricalDepositForFill,
  deploy as deployMulticall,
} from "../src/utils";
import { ZERO_BYTES } from "../src/constants";
import { CHAIN_ID_TEST_LIST, originChainId, destinationChainId, repaymentChainId } from "./constants";
import {
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
  winston,
  lastSpyLogIncludes,
} from "./utils";
import assert from "assert";
import { MockConfigStoreClient, MockHubPoolClient } from "./mocks";

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
    await deployMulticall(owner);

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
    spokePoolClient1 = new EVMSpokePoolClient(
      spyLogger,
      spokePool_1,
      hubPoolClient,
      originChainId,
      spokePool1DeploymentBlock
    );
    spokePoolClient2 = new EVMSpokePoolClient(
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

    let deposit = spokePoolClient1.getDepositForFill(fill);
    expect(deposit).to.exist;
    deposit = deposit!;

    expect(deposit)
      .excludingEvery(["quoteBlockNumber", "fromLiteChain", "toLiteChain", "message"])
      .to.deep.equal(deposit);
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

    // Set event search config from block to latest block so client doesn't see event.
    spokePoolClient1.eventSearchConfig.fromBlock = await spokePool_1.provider.getBlockNumber();
    spokePoolClient1.firstBlockToSearch = spokePoolClient1.eventSearchConfig.fromBlock;
    await spokePoolClient1.update();

    // Client has 0 deposits in memory so querying historical deposit sends fresh RPC requests.
    expect(spokePoolClient1.getDeposits().length).to.equal(0);

    const historicalDeposit = await spokePoolClient1.findDeposit(fill.depositId);

    assert.equal(historicalDeposit.found, true, "Test is broken");
    // tsc narrowing
    if (historicalDeposit.found) {
      expect(historicalDeposit.deposit.depositId.eq(deposit.depositId)).to.be.true;
    }
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

    // Set event search config to block to before deposit so client doesn't see event.
    spokePoolClient1.eventSearchConfig.toBlock = depositBlock - 1;
    await spokePoolClient1.update();

    // Make sure that the client's latestBlockSearched encompasses the event so it can see it on the subsequent
    // queryHistoricalDepositForFill call.
    spokePoolClient1.latestBlockSearched = depositBlock;

    // Client has 0 deposits in memory so querying historical deposit sends fresh RPC requests.
    expect(spokePoolClient1.getDeposits().length).to.equal(0);

    const historicalDeposit = await queryHistoricalDepositForFill(spokePoolClient1, fill);

    assert.equal(historicalDeposit.found, true, "Test is broken");
    // tsc narrowing
    if (historicalDeposit.found) {
      expect(historicalDeposit.deposit.depositId.eq(deposit.depositId)).to.be.true;
    }
  });

  it("Loads fills from memory with deposit ID > SpokePoolClient's earliest deposit ID queried", async function () {
    const deposit = await depositV3(
      spokePool_1,
      destinationChainId,
      depositor,
      inputToken,
      inputAmount,
      outputToken,
      outputAmount
    );

    await hre.network.provider.send("evm_mine");
    await hre.network.provider.send("evm_mine");

    // Configure the search range to skip the deposit.
    spokePoolClient1.firstBlockToSearch = deposit.blockNumber + 1;
    spokePoolClient1.eventSearchConfig.toBlock = undefined;
    await spokePoolClient1.update();

    // Client does not have the deposit and should search for it.
    expect((await spokePoolClient1.findDeposit(deposit.depositId)).found).is.true;
    expect(lastSpyLogIncludes(spy, "Located V3 deposit outside of SpokePoolClient's search range")).to.be.true;

    // Search the missing block range.
    spokePoolClient1.firstBlockToSearch = deposit.blockNumber - 1;
    await spokePoolClient1.update();

    // Client has the deposit now; should not search.
    expect((await spokePoolClient1.findDeposit(deposit.depositId)).found).is.true;
    expect(lastSpyLogIncludes(spy, "Located V3 deposit outside of SpokePoolClient's search range")).to.be.false;
  });

  it("Ignores fills with deposit ID < first deposit ID in spoke pool", async function () {
    // Make no deposit; search for depositId 0.
    const search = await spokePoolClient1.findDeposit(bnZero);
    assert.equal(search.found, false, "Test is broken");
    // tsc narrowing
    if (!search.found) {
      expect(search.code).to.equal(InvalidFill.DepositIdNotFound);
    }
  });

  it("Ignores fills with deposit ID > latest deposit ID in spoke pool", async function () {
    await depositV3(spokePool_1, destinationChainId, depositor, inputToken, inputAmount, outputToken, outputAmount);

    const nextDepositId = await spokePool_1.numberOfDeposits();
    await spokePoolClient1.update();
    const search = await spokePoolClient1.findDeposit(nextDepositId);

    assert.equal(search.found, false, "Test is broken");
    // tsc narrowing
    if (!search.found) {
      expect(search.code).to.equal(InvalidFill.DepositIdNotFound);
    }
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

    const search = await queryHistoricalDepositForFill(spokePoolClient1, {
      ...fill,
      outputAmount: fill.outputAmount.sub(bnOne),
    });
    assert.equal(search.found, false, "Test is broken");
    // tsc narrowing
    if (!search.found) {
      expect(search.code).to.equal(InvalidFill.FillMismatch);
    }
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
