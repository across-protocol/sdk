import { utils as ethersUtils } from "ethers";
import { arch } from "../src";
import { UNDEFINED_MESSAGE_HASH, ZERO_BYTES } from "../src/constants";
import { FillStatus } from "../src/interfaces";
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
  spreadEventWithBlockNumber,
  toBytes32,
} from "../src/utils";
import {
  expect,
  deploySpokePoolWithToken,
  deposit,
  setupTokensForWallet,
  ethers,
  Contract,
  BigNumber,
  SignerWithAddress,
} from "./utils";

const random = () => Math.round(Math.random() * 1e8);
const randomBytes = () => `0x${ethersUtils.randomBytes(48).join("").slice(0, 64)}`;

describe("SpokeUtils", function () {
  const message = randomBytes();
  const messageHash = ethersUtils.keccak256(message);
  const sampleData = {
    originChainId: random(),
    destinationChainId: random(),
    depositor: EvmAddress.from(randomAddress()),
    recipient: EvmAddress.from(randomAddress()),
    inputToken: EvmAddress.from(randomAddress()),
    inputAmount: toBN(random()),
    outputToken: EvmAddress.from(randomAddress()),
    outputAmount: toBN(random()),
    message,
    messageHash,
    depositId: toBN(random()),
    fillDeadline: random(),
    exclusiveRelayer: EvmAddress.from(randomAddress()),
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

  describe("Event extraction", function () {
    let originSpokePool: Contract, destinationSpokePool: Contract;
    let erc20: Contract, destErc20: Contract, weth: Contract;
    let depositor: SignerWithAddress, relayer: SignerWithAddress;
    let inputToken: EvmAddress, outputToken: EvmAddress;
    let inputAmount: BigNumber, outputAmount: BigNumber;
    let originChainId: number, destinationChainId: number;
    let originDeploymentBlock: number, destinationDeploymentBlock: number;

    beforeEach(async function () {
      [depositor, relayer] = await ethers.getSigners();

      // Deploy origin SpokePool
      const originDeployment = await deploySpokePoolWithToken(666); // Origin chain ID
      originSpokePool = originDeployment.spokePool;
      erc20 = originDeployment.erc20;
      weth = originDeployment.weth;
      originDeploymentBlock = originDeployment.deploymentBlock;
      originChainId = (await originSpokePool.callStatic.chainId()).toNumber();

      // Deploy destination SpokePool
      const destinationDeployment = await deploySpokePoolWithToken(137); // Destination chain ID
      destinationSpokePool = destinationDeployment.spokePool;
      destErc20 = destinationDeployment.erc20; // Use destination ERC20
      destinationDeploymentBlock = destinationDeployment.deploymentBlock;
      destinationChainId = (await destinationSpokePool.callStatic.chainId()).toNumber();

      // Setup tokens on both chains
      await setupTokensForWallet(originSpokePool, depositor, [erc20], weth, 10);
      await setupTokensForWallet(destinationSpokePool, relayer, [destErc20], weth, 10);

      const balance = await erc20.connect(depositor).balanceOf(depositor.address);
      inputToken = EvmAddress.from(erc20.address);
      outputToken = EvmAddress.from(destErc20.address);
      inputAmount = balance;
      outputAmount = inputAmount.sub(toBN(1));
    });

    describe("unpackDepositEvent", function () {
      it("should unpack deposit event correctly from real contract event", async function () {
        const depositEvent = await deposit(
          originSpokePool,
          destinationChainId,
          depositor,
          inputToken,
          inputAmount,
          outputToken,
          outputAmount
        );

        // Get the raw event from the transaction
        const filter = originSpokePool.filters.FundsDeposited();
        const events = await originSpokePool.queryFilter(filter, originDeploymentBlock);
        let rawEvent = events.at(-1);
        expect(rawEvent).to.exist;
        rawEvent = rawEvent!;

        const result = unpackDepositEvent(spreadEventWithBlockNumber(rawEvent), depositEvent.originChainId);

        expect(result.originChainId).to.equal(depositEvent.originChainId);
        expect(result.depositId.eq(depositEvent.depositId)).to.be.true;
        expect(result.depositor.eq(depositEvent.depositor)).to.be.true;
        expect(result.recipient.eq(depositEvent.recipient)).to.be.true;
        expect(result.inputToken.eq(depositEvent.inputToken)).to.be.true;
        expect(result.outputToken.eq(depositEvent.outputToken)).to.be.true;
        expect(result.exclusiveRelayer.eq(depositEvent.exclusiveRelayer)).to.be.true;
        expect(result.inputAmount.eq(depositEvent.inputAmount)).to.be.true;
        expect(result.outputAmount.eq(depositEvent.outputAmount)).to.be.true;
        expect(result.destinationChainId).to.equal(depositEvent.destinationChainId);
        expect(result.fillDeadline).to.equal(depositEvent.fillDeadline);
        expect(result.exclusivityDeadline).to.equal(depositEvent.exclusivityDeadline);
        expect(result.message).to.equal(depositEvent.message);
        expect(result.messageHash).to.equal(getMessageHash(depositEvent.message));
        expect(result.quoteTimestamp).to.equal(depositEvent.quoteTimestamp);
        expect(result.blockNumber).to.equal(rawEvent.blockNumber);
        expect(result.txnIndex).to.equal(rawEvent.transactionIndex);
        expect(result.txnRef).to.equal(rawEvent.transactionHash);
      });

      it("should handle deposit with custom message", async function () {
        const customMessage = "0x1234abcd";

        const depositEvent = await deposit(
          originSpokePool,
          destinationChainId,
          depositor,
          inputToken,
          inputAmount,
          outputToken,
          outputAmount,
          { message: customMessage }
        );

        // Get the raw event from the transaction
        const filter = originSpokePool.filters.FundsDeposited();
        const events = await originSpokePool.queryFilter(filter, originDeploymentBlock);
        let rawEvent = events.at(-1);
        expect(rawEvent).to.exist;
        rawEvent = rawEvent!;

        const result = unpackDepositEvent(spreadEventWithBlockNumber(rawEvent), depositEvent.originChainId);

        expect(result.message).to.equal(customMessage);
        expect(result.messageHash).to.equal(getMessageHash(customMessage));
        expect(result.messageHash).to.not.equal(ZERO_BYTES);
      });
    });

    describe("unpackFillEvent", function () {
      it("should unpack fill event correctly from real contract event", async function () {
        // First create a deposit on origin chain
        const depositEvent = await deposit(
          originSpokePool,
          destinationChainId,
          depositor,
          inputToken,
          inputAmount,
          outputToken,
          outputAmount
        );

        // Fill the relay on destination chain
        await destErc20.connect(relayer).approve(destinationSpokePool.address, outputAmount);
        await destinationSpokePool
          .connect(relayer)
          .fillRelay({ ...depositEvent, originChainId }, destinationChainId, toBytes32(relayer.address));

        // Get the raw fill event from the transaction
        const filter = destinationSpokePool.filters.FilledRelay();
        const events = await destinationSpokePool.queryFilter(filter, destinationDeploymentBlock);
        let rawEvent = events.at(-1);
        expect(rawEvent).to.exist;
        rawEvent = rawEvent!;

        const fill = unpackFillEvent(spreadEventWithBlockNumber(rawEvent), destinationChainId);

        expect(fill.destinationChainId).to.equal(destinationChainId);
        expect(fill.depositId.eq(depositEvent.depositId)).to.be.true;
        expect(fill.depositor.eq(depositEvent.depositor)).to.be.true;
        expect(fill.recipient.eq(depositEvent.recipient)).to.be.true;
        expect(fill.inputToken.eq(depositEvent.inputToken)).to.be.true;
        expect(fill.outputToken.eq(depositEvent.outputToken)).to.be.true;
        expect(fill.exclusiveRelayer.eq(depositEvent.exclusiveRelayer)).to.be.true;
        expect(fill.inputAmount.eq(depositEvent.inputAmount)).to.be.true;
        expect(fill.outputAmount.eq(depositEvent.outputAmount)).to.be.true;
        expect(fill.originChainId).to.equal(depositEvent.originChainId);
        expect(fill.fillDeadline).to.equal(depositEvent.fillDeadline);
        expect(fill.exclusivityDeadline).to.equal(depositEvent.exclusivityDeadline);
        expect(fill.messageHash).to.equal(getMessageHash(depositEvent.message));

        expect(fill.relayer.toNative()).to.equal(await relayer.getAddress());
        expect(fill.repaymentChainId).to.equal(destinationChainId);

        expect(fill.relayExecutionInfo).to.exist;
        expect(fill.relayExecutionInfo.updatedRecipient.eq(depositEvent.recipient)).to.be.true;
        expect(fill.relayExecutionInfo.updatedOutputAmount.eq(depositEvent.outputAmount)).to.be.true;
        expect(fill.relayExecutionInfo.updatedMessageHash).to.equal(depositEvent.messageHash);

        expect(fill.blockNumber).to.equal(rawEvent.blockNumber);
        expect(fill.txnIndex).to.equal(rawEvent.transactionIndex);
        expect(fill.txnRef).to.equal(rawEvent.transactionHash);

        // Test RelayData hash computation and fill status
        const depositHash = getRelayDataHash(depositEvent, destinationChainId);
        const fillHash = getRelayDataHash({ ...fill, message: depositEvent.message }, destinationChainId);
        expect(fillHash).to.equal(depositHash);

        // Check fill status before fill - should be Unfilled
        const fillStatusBefore = await arch.evm.relayFillStatus(
          destinationSpokePool,
          depositEvent,
          rawEvent.blockNumber - 1,
          destinationChainId
        );
        expect(fillStatusBefore).to.equal(FillStatus.Unfilled);

        // Check fill status after fill - should be Filled
        const fillStatusAfter = await arch.evm.relayFillStatus(
          destinationSpokePool,
          depositEvent,
          rawEvent.blockNumber,
          destinationChainId
        );
        expect(fillStatusAfter).to.equal(FillStatus.Filled);
      });
    });
  });
});
