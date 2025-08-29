import { utils as ethersUtils } from "ethers";
import { MAX_SAFE_DEPOSIT_ID, UNDEFINED_MESSAGE_HASH, ZERO_BYTES } from "../src/constants";
import {
  findInvalidFills,
  getMessageHash,
  getRelayEventKey,
  keccak256,
  randomAddress,
  toBN,
  validateFillForDeposit,
  EvmAddress,
  SvmAddress,
  getRelayDataHash,
  toAddressType,
  InvalidFill,
} from "../src/utils";
import { arch } from "../src";
import { expect, deploySpokePoolWithToken, Contract } from "./utils";
import { MockSpokePoolClient } from "./mocks";
import winston from "winston";

const random = () => Math.round(Math.random() * 1e8);
const randomBytes = () => `0x${ethersUtils.randomBytes(48).join("").slice(0, 64)}`;
const dummyLogger = winston.createLogger({ transports: [new winston.transports.Console()] });

const dummyFillProps = {
  relayer: toAddressType(randomAddress(), 1),
  repaymentChainId: random(),
  relayExecutionInfo: {
    updatedRecipient: toAddressType(randomAddress(), 1),
    updatedOutputAmount: toBN(random()),
    updatedMessageHash: ZERO_BYTES,
    fillType: 0,
  },
  blockNumber: random(),
  txnRef: randomBytes(),
  txnIndex: random(),
  logIndex: random(),
  quoteTimestamp: random(),
  quoteBlockNumber: random(),
  fromLiteChain: false,
  toLiteChain: false,
};

describe("SpokeUtils", function () {
  const message = randomBytes();
  const messageHash = ethersUtils.keccak256(message);
  const sampleData = {
    originChainId: random(),
    destinationChainId: random(),
    depositor: toAddressType(randomAddress(), 1),
    recipient: toAddressType(randomAddress(), 1),
    inputToken: toAddressType(randomAddress(), 1),
    inputAmount: toBN(random()),
    outputToken: toAddressType(randomAddress(), 1),
    outputAmount: toBN(random()),
    message,
    messageHash,
    depositId: toBN(random()),
    fillDeadline: random(),
    exclusiveRelayer: toAddressType(randomAddress(), 1),
    exclusivityDeadline: random(),
    ...dummyFillProps,
  };

  let spokePool: Contract;
  let deploymentBlock: number;

  beforeEach(async function () {
    ({ spokePool, deploymentBlock } = await deploySpokePoolWithToken(sampleData.originChainId));
  });

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

  describe("findInvalidFills", function () {
    let mockSpokePoolClient: MockSpokePoolClient;
    let mockSpokePoolClients: { [chainId: number]: MockSpokePoolClient };

    beforeEach(function () {
      mockSpokePoolClient = new MockSpokePoolClient(dummyLogger, spokePool, sampleData.originChainId, deploymentBlock);
      mockSpokePoolClient.getFills = () => [];
      mockSpokePoolClient.findDeposit = async () => {
        await Promise.resolve();
        return { found: false, code: InvalidFill.DepositIdNotFound, reason: "Deposit not found" };
      };

      mockSpokePoolClients = {
        [sampleData.originChainId]: mockSpokePoolClient,
      };
    });

    it("returns empty array when no fills exist", async function () {
      const invalidFills = await findInvalidFills(mockSpokePoolClients);
      expect(invalidFills).to.be.an("array").that.is.empty;
    });

    it("skips fills with unsafe deposit IDs", async function () {
      const unsafeDepositId = toBN(MAX_SAFE_DEPOSIT_ID).add(1);
      mockSpokePoolClient.getFills = () => [
        {
          ...sampleData,
          depositId: unsafeDepositId,
          messageHash,
          ...dummyFillProps,
        },
      ];

      const invalidFills = await findInvalidFills(mockSpokePoolClients);
      expect(invalidFills).to.be.an("array").that.is.empty;
    });

    it("detects fills with no matching deposits", async function () {
      mockSpokePoolClient.getFills = () => [
        {
          ...sampleData,
          depositId: toBN(random()),
          messageHash,
          ...dummyFillProps,
        },
      ];

      const invalidFills = await findInvalidFills(mockSpokePoolClients);
      expect(invalidFills).to.have.lengthOf(1);
      expect(invalidFills[0].reason).to.include("deposit with depositId");
    });

    it("detects fills with mismatched deposit attributes", async function () {
      const deposit = {
        ...sampleData,
        blockNumber: random(),
        txnRef: randomBytes(),
        txnIndex: random(),
        logIndex: random(),
        quoteTimestamp: random(),
        quoteBlockNumber: random(),
        fromLiteChain: false,
        toLiteChain: false,
        relayer: toAddressType(randomAddress(), 1),
        repaymentChainId: random(),
        relayExecutionInfo: {
          updatedRecipient: toAddressType(randomAddress(), 1),
          updatedOutputAmount: sampleData.outputAmount,
          updatedMessageHash: sampleData.messageHash,
          fillType: 0,
        },
      };

      const fill = {
        ...deposit,
        recipient: toAddressType(randomAddress(), 1),
        relayer: toAddressType(randomAddress(), 1),
        repaymentChainId: random(),
        relayExecutionInfo: {
          updatedRecipient: toAddressType(randomAddress(), 1),
          updatedOutputAmount: deposit.outputAmount,
          updatedMessageHash: deposit.messageHash,
          fillType: 0,
        },
      };

      mockSpokePoolClient.getFills = () => [fill];
      mockSpokePoolClient.findDeposit = async () => {
        await Promise.resolve();
        return {
          found: true,
          deposit,
        };
      };

      const invalidFills = await findInvalidFills(mockSpokePoolClients);
      expect(invalidFills).to.have.lengthOf(1);
      expect(invalidFills[0].reason).to.include("recipient mismatch");
    });

    it("handles multiple fills with different validation results", async function () {
      const validDeposit = {
        ...sampleData,
        blockNumber: random(),
        txnRef: randomBytes(),
        txnIndex: random(),
        logIndex: random(),
        quoteTimestamp: random(),
        quoteBlockNumber: random(),
        fromLiteChain: false,
        toLiteChain: false,
        relayer: toAddressType(randomAddress(), 1),
        repaymentChainId: random(),
        relayExecutionInfo: {
          updatedRecipient: sampleData.recipient,
          updatedOutputAmount: sampleData.outputAmount,
          updatedMessageHash: sampleData.messageHash,
          fillType: 0,
        },
      };

      const validFill = {
        ...validDeposit,
        relayer: toAddressType(randomAddress(), 1),
        repaymentChainId: random(),
        relayExecutionInfo: {
          updatedRecipient: validDeposit.recipient,
          updatedOutputAmount: validDeposit.outputAmount,
          updatedMessageHash: validDeposit.messageHash,
          fillType: 0,
        },
      };

      const invalidFill = {
        ...validDeposit,
        recipient: toAddressType(randomAddress(), 1),
        relayer: toAddressType(randomAddress(), 1),
        repaymentChainId: random(),
        relayExecutionInfo: {
          updatedRecipient: toAddressType(randomAddress(), 1),
          updatedOutputAmount: validDeposit.outputAmount,
          updatedMessageHash: validDeposit.messageHash,
          fillType: 0,
        },
      };

      mockSpokePoolClient.getFills = () => [validFill, invalidFill];
      mockSpokePoolClient.findDeposit = async () => {
        await Promise.resolve();
        return {
          found: true,
          deposit: validDeposit,
        };
      };

      const invalidFills = await findInvalidFills(mockSpokePoolClients);
      expect(invalidFills).to.have.lengthOf(1);
      expect(invalidFills[0].fill).to.deep.equal(invalidFill);
    });
  });
});
