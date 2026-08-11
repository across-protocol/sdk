import { CHAIN_IDs } from "@across-protocol/constants";
import { SvmSpokeClient } from "@across-protocol/contracts";
import { arrayify, hexZeroPad } from "ethers/lib/utils";
import {
  getRandomSvmAddress,
  getRelayDataHash,
  getRelayDataHashFromEvent,
  SvmRelayEventData,
  toAddress,
} from "../src/arch/svm";
import { RelayData } from "../src/interfaces";
import { BigNumber, randomAddress, toAddressType } from "../src/utils";
import { expect } from "./utils";

describe("SVM relay data hash", () => {
  const originChainId = CHAIN_IDs.MAINNET;
  const destinationChainId = CHAIN_IDs.SOLANA;

  const relayData = (depositId: number): RelayData & { messageHash: string } => ({
    originChainId,
    depositor: toAddressType(randomAddress(), originChainId),
    recipient: toAddressType(getRandomSvmAddress(), destinationChainId),
    inputToken: toAddressType(randomAddress(), originChainId),
    outputToken: toAddressType(getRandomSvmAddress(), destinationChainId),
    inputAmount: BigNumber.from(1_000),
    outputAmount: BigNumber.from(900),
    depositId: BigNumber.from(depositId),
    fillDeadline: 1_893_456_000,
    exclusivityDeadline: 0,
    exclusiveRelayer: toAddressType(getRandomSvmAddress(), destinationChainId),
    message: "0x1234",
    messageHash: `0x${"ab".repeat(32)}`,
  });

  const bytes32 = (value: BigNumber | string): Uint8Array =>
    arrayify(hexZeroPad(typeof value === "string" ? value : value.toHexString(), 32));

  // The relay data as it would be embedded in a FilledRelay or RequestedSlowFill event.
  const relayEventData = (relay: RelayData & { messageHash: string }): SvmRelayEventData => ({
    depositor: toAddress(relay.depositor),
    recipient: toAddress(relay.recipient),
    exclusiveRelayer: toAddress(relay.exclusiveRelayer),
    inputToken: toAddress(relay.inputToken),
    outputToken: toAddress(relay.outputToken),
    inputAmount: bytes32(relay.inputAmount),
    outputAmount: relay.outputAmount.toBigInt(),
    originChainId: BigInt(relay.originChainId),
    depositId: bytes32(relay.depositId),
    fillDeadline: relay.fillDeadline,
    exclusivityDeadline: relay.exclusivityDeadline,
    messageHash: bytes32(relay.messageHash),
  });

  it("computes the same relay data hash from relay data and from event data", () => {
    const relay = relayData(1);
    const expected = getRelayDataHash(relay, destinationChainId);
    expect(getRelayDataHashFromEvent(relayEventData(relay), destinationChainId)).to.equal(expected);
  });

  it("accepts FilledRelay events (structural superset of the embedded relay data)", () => {
    const relay = relayData(2);
    const relayer = getRandomSvmAddress();
    const fillEvent: SvmSpokeClient.FilledRelay = {
      ...relayEventData(relay),
      relayer,
      repaymentChainId: BigInt(destinationChainId),
      relayExecutionInfo: {
        updatedRecipient: toAddress(relay.recipient),
        updatedMessageHash: bytes32(relay.messageHash),
        updatedOutputAmount: relay.outputAmount.toBigInt(),
        fillType: SvmSpokeClient.FillType.FastFill,
      },
    };
    expect(getRelayDataHashFromEvent(fillEvent, destinationChainId)).to.equal(
      getRelayDataHash(relay, destinationChainId)
    );
  });

  it("distinguishes relays by their event data", () => {
    const relay = relayData(3);
    const other = relayEventData({ ...relay, depositId: BigNumber.from(4) });
    expect(getRelayDataHashFromEvent(other, destinationChainId)).to.not.equal(
      getRelayDataHash(relay, destinationChainId)
    );
  });

  it("hashes the messageHash commitment, not the message", () => {
    const relay = relayData(5);
    const differentMessage = { ...relay, message: "0x123456" };
    expect(getRelayDataHash(differentMessage, destinationChainId)).to.equal(
      getRelayDataHash(relay, destinationChainId)
    );
  });
});
