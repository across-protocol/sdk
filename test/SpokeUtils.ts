import { utils as ethersUtils } from "ethers";
import { UNDEFINED_MESSAGE_HASH, ZERO_BYTES } from "../src/constants";
import {
  getMessageHash,
  getRelayEventKey,
  keccak256,
  randomAddress,
  toBN,
  validateFillForDeposit,
  EvmAddress,
  SvmAddress,
  getRelayDataHash,
  unpackDepositEvent,
  unpackFillEvent,
} from "../src/utils";
import { relayFillStatus } from "../src/arch/evm/SpokeUtils";
import { arch } from "../src";
import {
  expect,
  deploySpokePoolWithToken,
  deposit,
  setupTokensForWallet,
  ethers,
  fillFromDeposit,
  Contract,
  BigNumber,
  SignerWithAddress,
} from "./utils";
import { FillStatus } from "../src/interfaces";

const random = () => Math.round(Math.random() * 1e8);
const randomBytes = () => `0x${ethersUtils.randomBytes(48).join("").slice(0, 64)}`;

describe("SpokeUtils", function () {
  const message = randomBytes();
  const messageHash = ethersUtils.keccak256(message);
  const sampleData = {
    originChainId: random(),
    destinationChainId: random(),
    depositor: randomAddress(),
    recipient: randomAddress(),
    inputToken: randomAddress(),
    inputAmount: toBN(random()),
    outputToken: randomAddress(),
    outputAmount: toBN(random()),
    message,
    messageHash,
    depositId: toBN(random()),
    fillDeadline: random(),
    exclusiveRelayer: randomAddress(),
    exclusivityDeadline: random(),
  };

  it("getRelayEventKey correctly concatenates an event key", function () {
    const eventKey = getRelayEventKey(sampleData);
    const expectedKey =
      `${sampleData.depositor}` +
      `-${sampleData.recipient}` +
      `-${sampleData.exclusiveRelayer}` +
      `-${sampleData.inputToken}` +
      `-${sampleData.outputToken}` +
      `-${sampleData.inputAmount}` +
      `-${sampleData.outputAmount}` +
      `-${sampleData.originChainId}` +
      `-${sampleData.destinationChainId}` +
      `-${sampleData.depositId}` +
      `-${sampleData.fillDeadline}` +
      `-${sampleData.exclusivityDeadline}` +
      `-${sampleData.messageHash}`;

    expect(eventKey).to.equal(expectedKey);
    eventKey.split("-").forEach((field) => expect(field).to.not.equal("undefined"));
  });

  it("validateFillForDeposit correctly detects unset messageHashes", function () {
    type validMatch = { valid: true } | { valid: false; reason: string };
    const validateResult = (result: validMatch, valid: boolean, reason: string) => {
      expect(result.valid).to.equal(valid);
      if (!result.valid) {
        expect(result.reason.startsWith(reason)).to.be.true;
      }
    };

    const testPairs = [
      { messageHash: UNDEFINED_MESSAGE_HASH, valid: false },
      { messageHash, valid: true },
    ];

    testPairs.forEach(({ messageHash, valid }) => {
      const result = validateFillForDeposit({ ...sampleData, messageHash }, sampleData);
      validateResult(result, valid, "messageHash mismatch");
    });

    testPairs.forEach(({ messageHash, valid }) => {
      const result = validateFillForDeposit(sampleData, { ...sampleData, messageHash });
      validateResult(result, valid, "messageHash mismatch");
    });

    let result = validateFillForDeposit(
      { ...sampleData, messageHash: UNDEFINED_MESSAGE_HASH },
      { ...sampleData, messageHash: UNDEFINED_MESSAGE_HASH }
    );
    validateResult(result, false, "messageHash mismatch");

    result = validateFillForDeposit(sampleData, sampleData);
    validateResult(result, true, "");
  });

  it("getMessageHash correctly handles empty messages", function () {
    expect(getMessageHash("")).to.equal(ZERO_BYTES);
    expect(getMessageHash("0x")).to.equal(ZERO_BYTES);
    expect(getMessageHash("0x1234")).to.equal(keccak256("0x1234"));

    const message = randomBytes();
    expect(getMessageHash(message)).to.equal(keccak256(message));
  });
  // Unlike previous tests, hardcode the correct outputs since any issue in the relay data hashing would output a different hash.
  it("Returns correct relay data hashes against historical values", function () {
    const destinationChainId = 10;
    const mockDeposit = {
      originChainId: 1,
      depositor: EvmAddress.from("0x9A8f92a830A5cB89a3816e3D267CB7791c16b04D"),
      recipient: SvmAddress.from("86ZyCV5E9XRYucpvQX8jupXveGyDLpnbmi8v5ixpXCrT"),
      inputToken: EvmAddress.from("0x9A8f92a830A5cB89a3816e3D267CB7791c16b04D"),
      inputAmount: toBN(100000),
      outputToken: SvmAddress.from("86ZyCV5E9XRYucpvQX8jupXveGyDLpnbmi8v5ixpXCrT"),
      outputAmount: toBN(99999),
      message: "0x",
      messageHash: getMessageHash("0x"),
      depositId: toBN(1),
      fillDeadline: 0,
      exclusiveRelayer: SvmAddress.from(ZERO_BYTES),
      exclusivityDeadline: 0,
    };
    const relayHashSvm = arch.svm.getRelayDataHash(mockDeposit, destinationChainId);
    const relayHashEvm = getRelayDataHash(mockDeposit, destinationChainId);
    expect(relayHashSvm).to.eq("0x0821462fe25774f2d35a0b31b853672481129eef690f28d8e7383a519443c5b0");
    expect(relayHashEvm).to.eq("0x483e0af898bcd167de637a4b336d92063ea2ff5b0721c4548227abf2aa2aeca9");

    mockDeposit.message = "0x123456";
    mockDeposit.messageHash = getMessageHash(mockDeposit.message);
    const relayHashWithMessageSvm = arch.svm.getRelayDataHash(mockDeposit, destinationChainId);
    const relayHashWithMessageEvm = getRelayDataHash(mockDeposit, destinationChainId);
    expect(relayHashWithMessageSvm).to.eq("0x3feedd6e7fc3866a895cadde1cc9519a08109f9c78255e0fc6f5538097273344");
    expect(relayHashWithMessageEvm).to.eq("0x296700dda08c58e3b2ad530ee4821f4d0e8b75f26854d218a9aa559e21d7c3e3");
  });

  describe("unpackDepositEvent", function () {
    let spokePool: Contract, erc20: Contract, destErc20: Contract, weth: Contract;
    let depositor: SignerWithAddress, deploymentBlock: number;
    let inputToken: EvmAddress, outputToken: EvmAddress;
    let inputAmount: BigNumber, outputAmount: BigNumber;

    beforeEach(async function () {
      [, depositor] = await ethers.getSigners();

      ({ spokePool, erc20, destErc20, weth, deploymentBlock } = await deploySpokePoolWithToken());
      await setupTokensForWallet(spokePool, depositor, [erc20, destErc20], weth, 10);

      const balance = await erc20.connect(depositor).balanceOf(depositor.address);
      inputToken = EvmAddress.from(erc20.address);
      outputToken = EvmAddress.from(destErc20.address);
      inputAmount = balance;
      outputAmount = inputAmount.sub(toBN(1));
    });

    it("should unpack deposit event correctly from real contract event", async function () {
      const destinationChainId = 137;

      const depositEvent = await deposit(
        spokePool,
        destinationChainId,
        depositor,
        inputToken,
        inputAmount,
        outputToken,
        outputAmount
      );

      // Get the raw event from the transaction
      const filter = spokePool.filters.FundsDeposited();
      const events = await spokePool.queryFilter(filter, deploymentBlock);
      const rawEvent = events[events.length - 1];

      const result = unpackDepositEvent(rawEvent, depositEvent.originChainId);

      expect(result.originChainId).to.equal(depositEvent.originChainId);
      expect(result.depositId.toString()).to.equal(depositEvent.depositId.toString());
      expect(result.depositor.toString()).to.equal(depositEvent.depositor.toString());
      expect(result.recipient.toString()).to.equal(depositEvent.recipient.toString());
      expect(result.inputToken.toString()).to.equal(depositEvent.inputToken.toString());
      expect(result.outputToken.toString()).to.equal(depositEvent.outputToken.toString());
      expect(result.exclusiveRelayer.toString()).to.equal(depositEvent.exclusiveRelayer.toString());
      expect(result.inputAmount.toString()).to.equal(depositEvent.inputAmount.toString());
      expect(result.outputAmount.toString()).to.equal(depositEvent.outputAmount.toString());
      expect(result.destinationChainId).to.equal(depositEvent.destinationChainId);
      expect(result.fillDeadline).to.equal(depositEvent.fillDeadline);
      expect(result.exclusivityDeadline).to.equal(depositEvent.exclusivityDeadline);
      expect(result.message).to.equal(depositEvent.message);
      expect(result.messageHash).to.equal(getMessageHash(depositEvent.message));
      expect(result.quoteTimestamp).to.equal(depositEvent.quoteTimestamp);
      expect(result.blockNumber).to.equal(rawEvent.blockNumber);
      expect(result.txnIndex).to.equal(rawEvent.transactionIndex);
      expect(result.txnRef.hash).to.equal(rawEvent.transactionHash);
    });

    it("should handle deposit with custom message", async function () {
      const destinationChainId = 137;
      const customMessage = "0x1234abcd";

      const depositEvent = await deposit(
        spokePool,
        destinationChainId,
        depositor,
        inputToken,
        inputAmount,
        outputToken,
        outputAmount,
        { message: customMessage }
      );

      // Get the raw event from the transaction
      const filter = spokePool.filters.FundsDeposited();
      const events = await spokePool.queryFilter(filter, deploymentBlock);
      const rawEvent = events[events.length - 1];

      const result = unpackDepositEvent(rawEvent, depositEvent.originChainId);

      expect(result.message).to.equal(customMessage);
      expect(result.messageHash).to.equal(getMessageHash(customMessage));
      expect(result.messageHash).to.not.equal(ZERO_BYTES);
    });
  });

  describe("unpackFillEvent", function () {
    let spokePool: Contract, erc20: Contract, destErc20: Contract, weth: Contract;
    let depositor: SignerWithAddress, relayer: SignerWithAddress, deploymentBlock: number;
    let inputToken: EvmAddress, outputToken: EvmAddress;
    let inputAmount: BigNumber, outputAmount: BigNumber;

    beforeEach(async function () {
      const signers = await ethers.getSigners();
      [, depositor, relayer] = signers;

      ({ spokePool, erc20, destErc20, weth, deploymentBlock } = await deploySpokePoolWithToken());
      await setupTokensForWallet(spokePool, depositor, [erc20, destErc20], weth, 10);
      await setupTokensForWallet(spokePool, relayer, [erc20, destErc20], weth, 10);

      const balance = await erc20.connect(depositor).balanceOf(depositor.address);
      inputToken = EvmAddress.from(erc20.address);
      outputToken = EvmAddress.from(destErc20.address);
      inputAmount = balance;
      outputAmount = inputAmount.sub(toBN(1));
    });

    it("should unpack fill event correctly from real contract event", async function () {
      const destinationChainId = 137;

      // First create a deposit
      const depositEvent = await deposit(
        spokePool,
        destinationChainId,
        depositor,
        inputToken,
        inputAmount,
        outputToken,
        outputAmount
      );

      // Create fill data from the deposit
      const fillData = fillFromDeposit(depositEvent, EvmAddress.from(relayer.address));

      // Execute the fill
      await destErc20.connect(relayer).approve(spokePool.address, outputAmount);
      await spokePool
        .connect(relayer)
        .fillRelay(
          fillData.depositor.toBytes32(),
          fillData.recipient.toBytes32(),
          fillData.exclusiveRelayer.toBytes32(),
          fillData.inputToken.toBytes32(),
          fillData.outputToken.toBytes32(),
          fillData.inputAmount,
          fillData.outputAmount,
          fillData.originChainId,
          fillData.destinationChainId,
          fillData.depositId,
          fillData.fillDeadline,
          fillData.exclusivityDeadline,
          fillData.message,
          fillData.relayExecutionInfo.updatedRecipient,
          fillData.relayExecutionInfo.updatedOutputAmount,
          fillData.relayExecutionInfo.updatedMessage,
          fillData.relayExecutionInfo.fillType
        );

      // Get the raw fill event from the transaction
      const filter = spokePool.filters.FilledRelay();
      const events = await spokePool.queryFilter(filter, deploymentBlock);
      const rawEvent = events[events.length - 1];

      const result = unpackFillEvent(rawEvent, destinationChainId);

      expect(result.destinationChainId).to.equal(destinationChainId);
      expect(result.depositId.toString()).to.equal(fillData.depositId.toString());
      expect(result.depositor.toString()).to.equal(fillData.depositor.toString());
      expect(result.recipient.toString()).to.equal(fillData.recipient.toString());
      expect(result.inputToken.toString()).to.equal(fillData.inputToken.toString());
      expect(result.outputToken.toString()).to.equal(fillData.outputToken.toString());
      expect(result.exclusiveRelayer.toString()).to.equal(fillData.exclusiveRelayer.toString());
      expect(result.relayer.toString()).to.equal(fillData.relayer.toString());
      expect(result.inputAmount.toString()).to.equal(fillData.inputAmount.toString());
      expect(result.outputAmount.toString()).to.equal(fillData.outputAmount.toString());
      expect(result.originChainId).to.equal(fillData.originChainId);
      expect(result.fillDeadline).to.equal(fillData.fillDeadline);
      expect(result.exclusivityDeadline).to.equal(fillData.exclusivityDeadline);
      expect(result.messageHash).to.equal(getMessageHash(fillData.message));
      expect(result.repaymentChainId).to.equal(fillData.repaymentChainId);
      expect(result.relayExecutionInfo.updatedRecipient.toString()).to.equal(
        fillData.relayExecutionInfo.updatedRecipient.toString()
      );
      expect(result.relayExecutionInfo.updatedOutputAmount.toString()).to.equal(
        fillData.relayExecutionInfo.updatedOutputAmount.toString()
      );
      expect(result.relayExecutionInfo.updatedMessage).to.equal(fillData.relayExecutionInfo.updatedMessage);
      expect(result.relayExecutionInfo.updatedMessageHash).to.equal(fillData.relayExecutionInfo.updatedMessageHash);
      expect(result.relayExecutionInfo.fillType).to.equal(fillData.relayExecutionInfo.fillType);
      expect(result.blockNumber).to.equal(rawEvent.blockNumber);
      expect(result.txnIndex).to.equal(rawEvent.transactionIndex);
      expect(result.txnRef.hash).to.equal(rawEvent.transactionHash);

      // Test RelayData hash computation and fill status
      const relayDataHash = getRelayDataHash(fillData, destinationChainId);
      expect(relayDataHash).to.be.a("string");
      expect(relayDataHash).to.have.lengthOf(66); // 0x + 64 hex chars

      // Check fill status before fill - should be Unfilled
      const fillStatusBefore = await relayFillStatus(spokePool, fillData, rawEvent.blockNumber - 1, destinationChainId);
      expect(fillStatusBefore).to.equal(FillStatus.Unfilled);

      // Check fill status after fill - should be Filled
      const fillStatusAfter = await relayFillStatus(spokePool, fillData, rawEvent.blockNumber, destinationChainId);
      expect(fillStatusAfter).to.equal(FillStatus.Filled);
    });

    it("should verify RelayData hash consistency between deposit and fill", async function () {
      const destinationChainId = 137;

      // Create a deposit
      const depositEvent = await deposit(
        spokePool,
        destinationChainId,
        depositor,
        inputToken,
        inputAmount,
        outputToken,
        outputAmount
      );

      // Create fill data from the deposit
      const fillData = fillFromDeposit(depositEvent, EvmAddress.from(relayer.address));

      // Compute hash from deposit data
      const depositRelayData = {
        originChainId: depositEvent.originChainId,
        depositor: depositEvent.depositor,
        recipient: depositEvent.recipient,
        inputToken: depositEvent.inputToken,
        outputToken: depositEvent.outputToken,
        inputAmount: depositEvent.inputAmount,
        outputAmount: depositEvent.outputAmount,
        depositId: depositEvent.depositId,
        fillDeadline: depositEvent.fillDeadline,
        exclusiveRelayer: depositEvent.exclusiveRelayer,
        exclusivityDeadline: depositEvent.exclusivityDeadline,
        message: depositEvent.message,
      };

      const depositHash = getRelayDataHash(depositRelayData, destinationChainId);
      const fillHash = getRelayDataHash(fillData, destinationChainId);

      // Hashes should be identical since they represent the same relay
      expect(depositHash).to.equal(fillHash);

      // Execute the fill
      await destErc20.connect(relayer).approve(spokePool.address, outputAmount);
      await spokePool
        .connect(relayer)
        .fillRelay(
          fillData.depositor.toBytes32(),
          fillData.recipient.toBytes32(),
          fillData.exclusiveRelayer.toBytes32(),
          fillData.inputToken.toBytes32(),
          fillData.outputToken.toBytes32(),
          fillData.inputAmount,
          fillData.outputAmount,
          fillData.originChainId,
          fillData.destinationChainId,
          fillData.depositId,
          fillData.fillDeadline,
          fillData.exclusivityDeadline,
          fillData.message,
          fillData.relayExecutionInfo.updatedRecipient,
          fillData.relayExecutionInfo.updatedOutputAmount,
          fillData.relayExecutionInfo.updatedMessage,
          fillData.relayExecutionInfo.fillType
        );

      // Verify the fill status using the hash
      const fillStatus = await relayFillStatus(spokePool, fillData, "latest", destinationChainId);
      expect(fillStatus).to.equal(FillStatus.Filled);
    });
  });
});
