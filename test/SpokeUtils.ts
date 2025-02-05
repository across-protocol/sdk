import { utils as ethersUtils } from "ethers";
import { UNDEFINED_MESSAGE_HASH, ZERO_BYTES } from "../src/constants";
import { getMessageHash, getRelayEventKey, keccak256, randomAddress, toBN, validateFillForDeposit } from "../src/utils";
import { expect } from "./utils";

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
    const testPairs = [
      { messageHash: UNDEFINED_MESSAGE_HASH, valid: false },
      { messageHash, valid: true },
    ];

    testPairs.forEach(({ messageHash, valid }) => {
      const result = validateFillForDeposit(
        { ...sampleData, messageHash },
        sampleData
      );

      expect(result.valid).to.equal(valid);
      if (!result.valid) {
        expect(result.reason.startsWith("messageHash mismatch")).to.be.true;
      }
    });

    testPairs.forEach(({ messageHash, valid }) => {
      const result = validateFillForDeposit(
        sampleData,
        { ...sampleData, messageHash }
      );

      expect(result.valid).to.equal(valid);
      if (!result.valid) {
        expect(result.reason.startsWith("messageHash mismatch")).to.be.true;
      }
    });

    const result = validateFillForDeposit(sampleData, sampleData);
    expect(result.valid).to.equal(true);
  });

  it("getMessageHash correctly handles empty messages", function () {
    expect(getMessageHash("")).to.equal(ZERO_BYTES);
    expect(getMessageHash("0x")).to.equal(ZERO_BYTES);
    expect(getMessageHash("0x1234")).to.equal(keccak256("0x1234"));

    const message = randomBytes();
    expect(getMessageHash(message)).to.equal(keccak256(message));
  });
});
