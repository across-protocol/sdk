import hre from "hardhat";
import { DepositWithBlock, FillStatus, FillType } from "../src/interfaces";
import { EVMSpokePoolClient, SpokePoolClient } from "../src/clients";
import {
  Address,
  bnOne,
  bnZero,
  deploy as deployMulticall,
  EvmAddress,
  toBN,
  InvalidFill,
  validateFillForDeposit,
  queryHistoricalDepositForFill,
  toAddressType,
  randomAddress,
} from "../src/utils";
import { fillStatusArray, relayFillStatus } from "../src/arch/evm";
import { ZERO_BYTES } from "../src/constants";
import { CHAIN_ID_TEST_LIST, originChainId, destinationChainId, repaymentChainId } from "./constants";
import {
  expect,
  BigNumber,
  toBNWei,
  ethers,
  SignerWithAddress,
  deposit,
  fillRelay,
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
  let inputToken: Address, outputToken: Address;
  let inputAmount: BigNumber, outputAmount: BigNumber;

  beforeEach(async function () {
    [owner, depositor, relayer] = await ethers.getSigners();
    await deployMulticall(owner);

    // Creat two spoke pools: one to act as the source and the other to act as the destination.
    ({
      spokePool: spokePool_1,
      erc20: erc20_1,
      deploymentBlock: spokePool1DeploymentBlock,
    } = await deploySpokePoolWithToken(originChainId));
    ({
      spokePool: spokePool_2,
      erc20: erc20_2,
      deploymentBlock: spokePool2DeploymentBlock,
    } = await deploySpokePoolWithToken(destinationChainId));
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

    inputToken = toAddressType(erc20_1.address, originChainId);
    inputAmount = toBNWei(1);
    outputToken = toAddressType(erc20_2.address, destinationChainId);
    outputAmount = inputAmount.sub(bnOne);
  });

  it("Correctly matches fills with deposits", async function () {
    const depositEvent = await deposit(
      spokePool_1,
      destinationChainId,
      depositor,
      inputToken,
      inputAmount,
      outputToken,
      outputAmount
    );
    const fill = await fillRelay(spokePool_2, depositEvent, relayer);
    await spokePoolClient2.update();

    expect(validateFillForDeposit(fill, depositEvent)).to.deep.equal({ valid: true });

    const ignoredFields = [
      "fromLiteChain",
      "toLiteChain",
      "blockNumber",
      "txnRef",
      "txnIndex",
      "logIndex",
      "relayer",
      "repaymentChainId",
      "relayExecutionInfo",
      "message",
    ];

    // For each RelayData field, toggle the value to produce an invalid fill. Verify that it's rejected.
    const fields = Object.keys(fill).filter((field) => !ignoredFields.includes(field));
    for (const field of fields) {
      let val: BigNumber | string | number | Address;
      if (BigNumber.isBigNumber(fill[field])) {
        val = fill[field].add(bnOne);
      } else if (typeof fill[field] === "string") {
        val = fill[field] + "1234";
      } else if (EvmAddress.validate(ethers.utils.arrayify(fill[field]))) {
        val = toAddressType(randomAddress(), destinationChainId);
      } else {
        expect(typeof fill[field]).to.equal("number");
        val = fill[field] + 1;
      }

      const result = validateFillForDeposit(fill, { ...depositEvent, [field]: val });
      expect(result.valid).to.be.false;
      expect((result as { reason: string }).reason.startsWith(`${field} mismatch`)).to.be.true;
    }

    // Verify that the underlying fill is untouched and still valid.
    expect(validateFillForDeposit(fill, depositEvent)).to.deep.equal({ valid: true });
  });

  it("Tracks v3 fill status", async function () {
    const depositEvent = await deposit(
      spokePool_1,
      destinationChainId,
      depositor,
      inputToken,
      inputAmount,
      outputToken,
      outputAmount
    );

    let filled = await relayFillStatus(spokePool_2, depositEvent);
    expect(filled).to.equal(FillStatus.Unfilled);

    // Also test spoke client variant
    filled = await spokePoolClient2.relayFillStatus(depositEvent);
    expect(filled).to.equal(FillStatus.Unfilled);

    await fillRelay(spokePool_2, depositEvent, relayer);
    filled = await relayFillStatus(spokePool_2, depositEvent);
    expect(filled).to.equal(FillStatus.Filled);

    // Also test spoke client variant
    filled = await spokePoolClient2.relayFillStatus(depositEvent);
    expect(filled).to.equal(FillStatus.Filled);
  });

  it("Tracks bulk v3 fill status", async function () {
    const deposits: DepositWithBlock[] = [];

    for (let i = 0; i < 5; ++i) {
      const depositEvent = await deposit(
        spokePool_1,
        destinationChainId,
        depositor,
        inputToken,
        inputAmount,
        outputToken,
        outputAmount
      );
      deposits.push(depositEvent);
    }
    expect(deposits.length).to.be.greaterThan(0);

    let fills = await fillStatusArray(spokePool_2, deposits);
    expect(fills.length).to.equal(deposits.length);
    fills.forEach((fillStatus) => expect(fillStatus).to.equal(FillStatus.Unfilled));

    // Fill the first deposit and verify that the status updates correctly.
    await fillRelay(spokePool_2, deposits[0], relayer);
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
    await Promise.all(deposits.slice(1).map((deposit) => fillRelay(spokePool_2, deposit, relayer)));
    fills = await fillStatusArray(spokePool_2, deposits);
    expect(fills.length).to.equal(deposits.length);
    fills.forEach((fillStatus) => expect(fillStatus).to.equal(FillStatus.Filled));
  });

  it("Accepts valid fills", async function () {
    const depositEvent = await deposit(
      spokePool_1,
      destinationChainId,
      depositor,
      inputToken,
      inputAmount,
      outputToken,
      outputAmount
    );
    await fillRelay(spokePool_2, depositEvent, relayer);

    await spokePoolClient2.update();
    await spokePoolClient1.update();

    const [depositEvent_1] = spokePoolClient1.getDeposits();
    const [fill_1] = spokePoolClient2.getFills();

    // Some fields are expected to be dynamically populated by the client, but aren't in this environment.
    // Fill them in manually from the fill struct to get a valid comparison.
    expect(validateFillForDeposit(fill_1, depositEvent_1)).to.deep.equal({ valid: true });
  });

  it("Returns deposit matched with fill", async function () {
    const depositEvent = await deposit(
      spokePool_1,
      destinationChainId,
      depositor,
      inputToken,
      inputAmount,
      outputToken,
      outputAmount
    );

    const fill = await fillRelay(spokePool_2, depositEvent, relayer);

    expect(spokePoolClient2.getDepositForFill(fill)).to.not.exist;
    await spokePoolClient1.update();

    let _deposit = spokePoolClient1.getDepositForFill(fill);
    expect(_deposit).to.exist;
    _deposit = _deposit!;

    expect(_deposit)
      .excludingEvery([
        "quoteBlockNumber",
        "fromLiteChain",
        "toLiteChain",
        "message",
        "depositor",
        "recipient",
        "inputToken",
        "outputToken",
        "exclusiveRelayer",
      ])
      .to.deep.equal(depositEvent);
    expect(_deposit.depositor.eq(depositEvent.depositor)).to.be.true;
    expect(_deposit.recipient.eq(depositEvent.recipient)).to.be.true;
    expect(_deposit.inputToken.eq(depositEvent.inputToken)).to.be.true;
    expect(_deposit.outputToken.eq(depositEvent.outputToken)).to.be.true;
    expect(_deposit.exclusiveRelayer.eq(depositEvent.exclusiveRelayer)).to.be.true;
  });

  it("Can fetch older deposit matching fill", async function () {
    const depositEvent = await deposit(
      spokePool_1,
      destinationChainId,
      depositor,
      inputToken,
      inputAmount,
      outputToken,
      outputAmount
    );
    await fillRelay(spokePool_2, depositEvent, relayer);
    await spokePoolClient2.update();
    const [fill] = spokePoolClient2.getFills();

    // Set event search config from block ahead of the deposit block so client doesn't see event.
    spokePoolClient1.firstHeightToSearch = depositEvent.blockNumber + 1;
    await spokePoolClient1.update();

    // Client has 0 deposits in memory so querying historical deposit sends fresh RPC requests.
    expect(spokePoolClient1.getDeposits().length).to.equal(0);

    const historicalDeposit = await spokePoolClient1.findDeposit(fill.depositId);

    assert.equal(historicalDeposit.found, true, "Test is broken");
    // tsc narrowing
    if (historicalDeposit.found) {
      expect(historicalDeposit.deposit.depositId.eq(depositEvent.depositId)).to.be.true;
    }
  });

  it("Can fetch younger deposit matching fill", async function () {
    const depositEvent = await deposit(
      spokePool_1,
      destinationChainId,
      depositor,
      inputToken,
      inputAmount,
      outputToken,
      outputAmount
    );
    const { blockNumber: depositBlock } = depositEvent;

    await fillRelay(spokePool_2, depositEvent, relayer);
    await spokePoolClient2.update();
    const [fill] = spokePoolClient2.getFills();

    // Set event search config to block to after deposit so client doesn't see event.
    spokePoolClient1.firstHeightToSearch = depositBlock + 1;
    await spokePoolClient1.update();

    // Make sure that the client's latestBlockSearched encompasses the event so it can see it on the subsequent
    // queryHistoricalDepositForFill call.
    spokePoolClient1.latestHeightSearched = depositBlock;

    // Client has 0 deposits in memory so querying historical deposit sends fresh RPC requests.
    expect(spokePoolClient1.getDeposits().length).to.equal(0);

    const historicalDeposit = await queryHistoricalDepositForFill(spokePoolClient1, fill);

    assert.equal(historicalDeposit.found, true, "Test is broken");
    // tsc narrowing
    if (historicalDeposit.found) {
      expect(historicalDeposit.deposit.depositId.eq(depositEvent.depositId)).to.be.true;
    }
  });

  it("Loads fills from memory with deposit ID > SpokePoolClient's earliest deposit ID queried", async function () {
    const depositEvent = await deposit(
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
    spokePoolClient1.firstHeightToSearch = depositEvent.blockNumber + 1;
    spokePoolClient1.eventSearchConfig.to = undefined;
    await spokePoolClient1.update();

    // Client does not have the deposit and should search for it.
    expect((await spokePoolClient1.findDeposit(depositEvent.depositId)).found).is.true;
    expect(lastSpyLogIncludes(spy, "Located deposit outside of SpokePoolClient's search range")).to.be.true;

    // Search the missing block range.
    spokePoolClient1.firstHeightToSearch = deposit.blockNumber - 1;
    await spokePoolClient1.update();

    // Client has the deposit now; should not search.
    expect((await spokePoolClient1.findDeposit(depositEvent.depositId)).found).is.true;
    expect(lastSpyLogIncludes(spy, "Located deposit outside of SpokePoolClient's search range")).to.be.false;
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
    await deposit(spokePool_1, destinationChainId, depositor, inputToken, inputAmount, outputToken, outputAmount);

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
    const depositEvent = await deposit(
      spokePool_1,
      destinationChainId,
      depositor,
      inputToken,
      inputAmount,
      outputToken,
      outputAmount
    );

    depositEvent.outputAmount = depositEvent.outputAmount.sub(bnOne);
    const fill = await fillRelay(spokePool_2, depositEvent, relayer);

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
    const depositEvent_1 = await deposit(
      spokePool_1,
      destinationChainId,
      depositor,
      inputToken,
      inputAmount,
      outputToken,
      outputAmount
    );
    await spokePoolClient1.update();

    const fill_1 = await fillRelay(spokePool_2, depositEvent_1, relayer);
    const fill_2 = await fillRelay(
      spokePool_2,
      {
        ...depositEvent_1,
        recipient: toAddressType(relayer.address),
        outputAmount: depositEvent_1.outputAmount.div(2),
        message: "0x12",
      },
      relayer
    );

    // Sanity Check: Ensure that fill2 is defined
    expect(fill_2).to.not.be.undefined;
    if (!fill_2) {
      throw new Error("fill_2 is undefined");
    }

    expect(fill_1.relayExecutionInfo.updatedRecipient.toNative() === depositor.address).to.be.true;
    expect(fill_2.relayExecutionInfo.updatedRecipient.toNative() === relayer.address).to.be.true;
    expect(fill_2.relayExecutionInfo.updatedMessageHash === ethers.utils.keccak256("0x12")).to.be.true;
    expect(fill_1.relayExecutionInfo.updatedMessageHash === ZERO_BYTES).to.be.true;
    expect(fill_1.relayExecutionInfo.updatedOutputAmount.eq(fill_2.relayExecutionInfo.updatedOutputAmount)).to.be.false;
    expect(fill_1.relayExecutionInfo.fillType === FillType.FastFill).to.be.true;
    expect(fill_2.relayExecutionInfo.fillType === FillType.FastFill).to.be.true;

    const _deposit = spokePoolClient1.getDepositForFill(fill_1);
    expect(_deposit).to.exist;
    let result = validateFillForDeposit(fill_1, _deposit);
    expect(result.valid).to.be.true;
    expect(spokePoolClient1.getDepositForFill(fill_2)).to.not.exist;

    const depositEvent_2 = await deposit(
      spokePool_1,
      destinationChainId,
      depositor,
      inputToken,
      inputAmount,
      outputToken,
      outputAmount
    );
    const fill = await fillRelay(spokePool_2, depositEvent_2, relayer);

    await spokePoolClient2.update();

    expect(validateFillForDeposit(fill, depositEvent_2)).to.deep.equal({ valid: true });

    // Changed the input token.
    result = validateFillForDeposit(fill, { ...depositEvent_2, inputToken: owner.address });
    expect(result.valid).to.be.false;
    expect((result as { reason: string }).reason.startsWith("inputToken mismatch")).to.be.true;

    // Invalid input amount.
    result = validateFillForDeposit({ ...fill, inputAmount: toBNWei(1337) }, depositEvent_2);
    expect(result.valid).to.be.false;
    expect((result as { reason: string }).reason.startsWith("inputAmount mismatch")).to.be.true;

    // Changed the output token.
    result = validateFillForDeposit(fill, { ...depositEvent_2, outputToken: owner.address });
    expect(result.valid).to.be.false;
    expect((result as { reason: string }).reason.startsWith("outputToken mismatch")).to.be.true;

    // Changed the output amount.
    result = validateFillForDeposit({ ...fill, outputAmount: toBNWei(1337) }, depositEvent_2);
    expect(result.valid).to.be.false;
    expect((result as { reason: string }).reason.startsWith("outputAmount mismatch")).to.be.true;

    // Invalid depositId.
    result = validateFillForDeposit({ ...fill, depositId: toBN(1337) }, depositEvent_2);
    expect(result.valid).to.be.false;
    expect((result as { reason: string }).reason.startsWith("depositId mismatch")).to.be.true;

    // Changed the depositor.
    result = validateFillForDeposit({ ...fill, depositor: relayer.address }, depositEvent_2);
    expect(result.valid).to.be.false;
    expect((result as { reason: string }).reason.startsWith("depositor mismatch")).to.be.true;

    // Changed the recipient.
    result = validateFillForDeposit({ ...fill, recipient: relayer.address }, depositEvent_2);
    expect(result.valid).to.be.false;
    expect((result as { reason: string }).reason.startsWith("recipient mismatch")).to.be.true;
  });
  it("Matches fills with deposits across different address families (family-agnostic comparison)", async function () {
    // This test isolates validateFillForDeposit itself (not construction paths).
    // Bypass toAddressType by injecting address objects of different families that share raw bytes.
    // Old code using toString() would false-negative here; new code uses toBytes32() so it passes.
    const { SvmAddress, TvmAddress, EvmAddress, RawAddress } = await import("../src/utils/AddressUtils");
    const { utils } = await import("ethers");
    const bs58 = await import("bs58");

    // Use a 20-byte value that is valid as EVM and TVM, and use its 32-byte padded form for SVM.
    const raw20 = "0x" + "ab".repeat(20);
    const raw32Hex = utils.hexZeroPad(raw20, 32).toLowerCase();

    // Build addresses of different families wrapping the SAME raw bytes
    const evmAddr = EvmAddress.from(raw20);
    const tvmAddr = TvmAddress.from(raw20);
    // SVM needs 32 bytes with non-zero leading bytes; our raw32 has 12 zero leading bytes -> SvmAddress.validate would reject.
    // Use a 32-byte value with non-zero prefix for SVM, and compare EVM vs Raw instead for the core assertion.
    // For EVM vs TVM, both are 20-byte, so they share exact raw bytes -> strongest proof.
    expect(evmAddr.toBytes32()).to.equal(tvmAddr.toBytes32());
    expect(evmAddr.toString()).to.not.equal(tvmAddr.toString()); // doc says toString is not identity

    // Construct minimal RelayData-like objects to exercise validateFillForDeposit directly
    const baseRelay: any = {
      depositId: toBN(1),
      originChainId,
      destinationChainId,
      depositor: evmAddr,
      recipient: evmAddr,
      inputToken: evmAddr,
      inputAmount: toBNWei(1),
      outputToken: evmAddr,
      outputAmount: toBNWei(1),
      fillDeadline: Math.floor(Date.now() / 1000) + 3600,
      exclusivityDeadline: 0,
      exclusiveRelayer: EvmAddress.from("0x0000000000000000000000000000000000000000"),
      messageHash: utils.keccak256("0x"),
    };
    const baseDeposit: any = {
      ...baseRelay,
      message: "0x",
      messageHash: baseRelay.messageHash,
      quoteTimestamp: Math.floor(Date.now() / 1000),
      fromLiteChain: false,
      toLiteChain: false,
    };

    // Same family — should pass (baseline)
    expect(validateFillForDeposit({ ...baseRelay, depositor: evmAddr }, { ...baseDeposit, depositor: evmAddr }).valid).to.be.true;

    // Cross-family same bytes — OLD toString would fail, NEW toBytes32 must pass
    expect(validateFillForDeposit({ ...baseRelay, depositor: evmAddr }, { ...baseDeposit, depositor: tvmAddr }).valid).to.be.true;
    expect(validateFillForDeposit({ ...baseRelay, recipient: tvmAddr }, { ...baseDeposit, recipient: evmAddr }).valid).to.be.true;
    expect(validateFillForDeposit({ ...baseRelay, inputToken: tvmAddr }, { ...baseDeposit, inputToken: evmAddr }).valid).to.be.true;
    expect(validateFillForDeposit({ ...baseRelay, outputToken: evmAddr }, { ...baseDeposit, outputToken: tvmAddr }).valid).to.be.true;
    expect(validateFillForDeposit({ ...baseRelay, exclusiveRelayer: evmAddr }, { ...baseDeposit, exclusiveRelayer: tvmAddr }).valid).to.be.true;

    // RawAddress (fallback family) vs EvmAddress same bytes — must also pass
    const rawAddr = new RawAddress(utils.arrayify(raw32Hex));
    expect(rawAddr.toBytes32()).to.equal(evmAddr.toBytes32());
    expect(validateFillForDeposit({ ...baseRelay, depositor: evmAddr }, { ...baseDeposit, depositor: rawAddr }).valid).to.be.true;

    // Different bytes must still be rejected — prove we didn't make comparison too permissive
    const other20 = "0x" + "cd".repeat(20);
    const otherEvm = EvmAddress.from(other20);
    expect(validateFillForDeposit({ ...baseRelay, depositor: evmAddr }, { ...baseDeposit, depositor: otherEvm }).valid).to.be.false;
    expect(validateFillForDeposit({ ...baseRelay, depositor: otherEvm }, { ...baseDeposit, depositor: evmAddr }).valid).to.be.false;

    // Cached-string interop: deposit comes from JSON cache (Address.toJSON() -> native string)
    // Simulate by using string instead of Address object for deposit side
    const cachedDeposit = { ...baseDeposit, depositor: evmAddr.toString() as any }; // string, not Address
    expect(validateFillForDeposit({ ...baseRelay, depositor: evmAddr }, cachedDeposit).valid).to.be.true;
    // Cached TVM string vs EVM object — same raw bytes, different native encodings -> must still match
    const cachedTvmString = tvmAddr.toString();
    expect(validateFillForDeposit({ ...baseRelay, depositor: evmAddr }, { ...baseDeposit, depositor: cachedTvmString as any }).valid).to.be.true;

    // Non-address field mismatch must still be detected (sanity: we didn't break primitive comparison)
    expect(validateFillForDeposit({ ...baseRelay, depositId: toBN(999) }, baseDeposit).valid).to.be.false;
    expect(validateFillForDeposit({ ...baseRelay, inputAmount: toBNWei(999) }, baseDeposit).valid).to.be.false;
  });

});
