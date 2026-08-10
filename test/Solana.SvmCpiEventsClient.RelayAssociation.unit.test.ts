import { CHAIN_IDs } from "@across-protocol/constants";
import { address, signature } from "@solana/kit";
import { SvmSpokeClient } from "@across-protocol/contracts";
import { arrayify, hexZeroPad } from "ethers/lib/utils";
import {
  DecodedEvent,
  EventWithData,
  getRandomSvmAddress,
  RelayEventName,
  SvmCpiEventsClient,
  toAddress,
} from "../src/arch/svm";
import { RelayDataWithMessageHash } from "../src/interfaces";
import { BigNumber, randomAddress, toAddressType } from "../src/utils";
import { expect } from "./utils";

describe("SvmCpiEventsClient (relay event association)", () => {
  const program = address("DLv3NggMiSaef97YCkew5xKUHDh13tVGZ7tydt3ZeAru");
  const originChainId = CHAIN_IDs.MAINNET;
  const destinationChainId = CHAIN_IDs.SOLANA;

  const relayData = (depositId: number): RelayDataWithMessageHash => ({
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
    message: "0x",
    messageHash: `0x${"ab".repeat(32)}`,
  });

  const bytes32 = (value: BigNumber | string): Uint8Array =>
    arrayify(hexZeroPad(typeof value === "string" ? value : value.toHexString(), 32));

  const fillEvent = (relay: RelayDataWithMessageHash): SvmSpokeClient.FilledRelay => ({
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
    messageHash: bytes32(relay.messageHash ?? "0x"),
    relayer: getRandomSvmAddress(),
    repaymentChainId: BigInt(destinationChainId),
    relayExecutionInfo: {
      updatedRecipient: toAddress(relay.recipient),
      updatedMessageHash: bytes32(relay.messageHash ?? "0x"),
      updatedOutputAmount: relay.outputAmount.toBigInt(),
      fillType: SvmSpokeClient.FillType.FastFill,
    },
  });

  const requestSlowFillEvent = (relay: RelayDataWithMessageHash): SvmSpokeClient.RequestedSlowFill => {
    const {
      relayer: _relayer,
      repaymentChainId: _repaymentChainId,
      relayExecutionInfo: _info,
      ...event
    } = fillEvent(relay);
    return event;
  };

  // Exercise the real queryEventsForRelay() implementation against a stubbed event source by shadowing the
  // private queryAllEvents member at runtime. Object.create() returns `any` and Object.assign() merges the
  // stubbed members without reference to the class's private declarations, so no type assertions are needed.
  const client = (events: DecodedEvent<RelayEventName>[]): SvmCpiEventsClient => {
    const stub: SvmCpiEventsClient = Object.create(SvmCpiEventsClient.prototype);
    return Object.assign(stub, {
      programAddress: program,
      queryAllEvents: (): Promise<EventWithData[]> =>
        Promise.resolve(
          events.map((decoded, index) => ({
            ...decoded,
            slot: BigInt(index),
            // A valid-form (all-zero-bytes) signature; the association logic never inspects it.
            signature: signature("1".repeat(64)),
            blockTime: null,
            confirmationStatus: "confirmed",
            program,
          }))
        ),
    });
  };

  it("returns only events belonging to the queried relay", async () => {
    const expected = relayData(1);
    const other = { ...expected, depositId: BigNumber.from(2) };
    const eventsClient = client([
      { name: "FilledRelay", data: fillEvent(other) },
      { name: "FilledRelay", data: fillEvent(expected) },
    ]);

    const events = await eventsClient.queryEventsForRelay(expected, destinationChainId, ["FilledRelay"]);

    expect(events.length).to.equal(1);
    expect(events[0].slot).to.equal(BigInt(1));
  });

  it("filters by event name", async () => {
    const expected = relayData(3);
    const eventsClient = client([
      { name: "RequestedSlowFill", data: requestSlowFillEvent(expected) },
      { name: "FilledRelay", data: fillEvent(expected) },
    ]);

    const fills = await eventsClient.queryEventsForRelay(expected, destinationChainId, ["FilledRelay"]);
    const all = await eventsClient.queryEventsForRelay(expected, destinationChainId, [
      "FilledRelay",
      "RequestedSlowFill",
    ]);

    expect(fills.length).to.equal(1);
    expect(fills[0].name).to.equal("FilledRelay");
    expect(all.length).to.equal(2);
  });

  it("associates by messageHash", async () => {
    const expected = relayData(4);
    const otherMessage = { ...expected, messageHash: `0x${"cd".repeat(32)}` };
    const eventsClient = client([{ name: "FilledRelay", data: fillEvent(otherMessage) }]);

    const events = await eventsClient.queryEventsForRelay(expected, destinationChainId, ["FilledRelay"]);

    expect(events.length).to.equal(0);
  });
});
