import { utils as ethersUtils } from "ethers";
import { ZERO_BYTES } from "../src/constants";
import { getMessageHash, getRelayEventKey, keccak256, randomAddress, toBN } from "../src/utils";
import { expect } from "./utils";

const random = () => Math.round(Math.random() * 1e8);

describe("SpokeUtils", function () {
  it("getRelayEventKey correctly concatenates an event key", function () {
    const data = {
      originChainId: random(),
      destinationChainId: random(),
      depositor: randomAddress(),
      recipient: randomAddress(),
      inputToken: randomAddress(),
      inputAmount: toBN(random()),
      outputToken: randomAddress(),
      outputAmount: toBN(random()),
      message: `0x${ethersUtils.randomBytes(48).join("")}`,
      depositId: toBN(random()),
      fillDeadline: random(),
      exclusiveRelayer: randomAddress(),
      exclusivityDeadline: random(),
    };

    const eventKey = getRelayEventKey(data);
    const expectedKey =
      `${data.depositor}` +
      `-${data.recipient}` +
      `-${data.exclusiveRelayer}` +
      `-${data.inputToken}` +
      `-${data.outputToken}` +
      `-${data.inputAmount}` +
      `-${data.outputAmount}` +
      `-${data.originChainId}` +
      `-${data.destinationChainId}` +
      `-${data.depositId}` +
      `-${data.fillDeadline}` +
      `-${data.exclusivityDeadline}` +
      `-${data.message}`;

    expect(eventKey).to.equal(expectedKey);
    eventKey.split("-").forEach((field) => expect(field).to.not.equal("undefined"));
  });

  it("getMessageHash correctly handles empty messages", function () {
    expect(getMessageHash("")).to.equal(ZERO_BYTES);
    expect(getMessageHash("0x")).to.equal(ZERO_BYTES);
    expect(getMessageHash("0x1234")).to.equal(keccak256("0x1234"));

    const message = `0x${ethersUtils.randomBytes(48).join("")}`;
    expect(getMessageHash(message)).to.equal(keccak256(message));
  });
});
