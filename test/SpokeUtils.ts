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
} from "../src/utils";
import { expect, deploySpokePoolWithToken, Contract } from "./utils";
import { MockSpokePoolClient } from "./mocks";
import winston from "winston";

const random = () => Math.round(Math.random() * 1e8);
const randomBytes = () => `0x${ethersUtils.randomBytes(48).join("").slice(0, 64)}`;
const dummyLogger = winston.createLogger({ transports: [new winston.transports.Console()] });

const dummyFillProps = {
  relayer: randomAddress(),
  repaymentChainId: random(),
  relayExecutionInfo: {
    updatedRecipient: randomAddress(),
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
    ...dummyFillProps,
  };

  let spokePool: Contract;
  let deploymentBlock: number;

  beforeEach(async function () {
    ({ spokePool, deploymentBlock } = await deploySpokePoolWithToken(
      sampleData.originChainId
    ));
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

  describe("findInvalidFills", function () {
    let mockSpokePoolClient: MockSpokePoolClient;
    let mockSpokePoolClients: { [chainId: number]: MockSpokePoolClient };

    beforeEach(function () {
      mockSpokePoolClient = new MockSpokePoolClient(dummyLogger, spokePool, sampleData.originChainId, deploymentBlock);
      mockSpokePoolClient.getFills = () => [];
      mockSpokePoolClient.findAllDeposits = async () => {
        await Promise.resolve();
        return { found: false, code: 0, reason: "Deposit not found" };
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
      expect(invalidFills[0].validationResults).to.have.lengthOf(1);
      expect(invalidFills[0].validationResults[0].reason).to.include("deposit with depositId");
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
        relayer: randomAddress(),
        repaymentChainId: random(),
        relayExecutionInfo: {
          updatedRecipient: randomAddress(),
          updatedOutputAmount: sampleData.outputAmount,
          updatedMessageHash: sampleData.messageHash,
          fillType: 0,
        },
      };

      const fill = {
        ...deposit,
        recipient: randomAddress(),
        relayer: randomAddress(),
        repaymentChainId: random(),
        relayExecutionInfo: {
          updatedRecipient: randomAddress(),
          updatedOutputAmount: deposit.outputAmount,
          updatedMessageHash: deposit.messageHash,
          fillType: 0,
        },
      };

      mockSpokePoolClient.getFills = () => [fill];
      mockSpokePoolClient.findAllDeposits = async () => {
        await Promise.resolve();
        return {
          found: true,
          deposits: [deposit],
        };
      };

      const invalidFills = await findInvalidFills(mockSpokePoolClients);
      expect(invalidFills).to.have.lengthOf(1);
      expect(invalidFills[0].validationResults).to.have.lengthOf(1);
      expect(invalidFills[0].validationResults[0].reason).to.include("recipient mismatch");
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
        relayer: randomAddress(),
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
        relayer: randomAddress(),
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
        recipient: randomAddress(),
        relayer: randomAddress(),
        repaymentChainId: random(),
        relayExecutionInfo: {
          updatedRecipient: randomAddress(),
          updatedOutputAmount: validDeposit.outputAmount,
          updatedMessageHash: validDeposit.messageHash,
          fillType: 0,
        },
      };

      mockSpokePoolClient.getFills = () => [validFill, invalidFill];
      mockSpokePoolClient.findAllDeposits = async () => {
        await Promise.resolve();
        return {
          found: true,
          deposits: [validDeposit],
        };
      };

      const invalidFills = await findInvalidFills(mockSpokePoolClients);
      expect(invalidFills).to.have.lengthOf(1);
      expect(invalidFills[0].fill).to.deep.equal(invalidFill);
    });
  });
});
