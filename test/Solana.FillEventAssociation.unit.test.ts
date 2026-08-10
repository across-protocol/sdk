import { CHAIN_IDs } from "@across-protocol/constants";
import { address, signature } from "@solana/kit";
import { SvmSpokeClient } from "@across-protocol/contracts";
import { arrayify, hexZeroPad } from "ethers/lib/utils";
import {
  DecodedEvent,
  EventWithData,
  findFillEvent,
  getRandomSvmAddress,
  relayFillStatus,
  RelayEventName,
  SvmCpiEventsClient,
  toAddress,
} from "../src/arch/svm";
import { FillStatus, RelayDataWithMessageHash } from "../src/interfaces";
import { BigNumber, randomAddress, toAddressType } from "../src/utils";
import { createSpyLogger, expect } from "./utils";

describe("SVM fill event association", () => {
  const program = address("DLv3NggMiSaef97YCkew5xKUHDh13tVGZ7tydt3ZeAru");
  const originChainId = CHAIN_IDs.MAINNET;
  const destinationChainId = CHAIN_IDs.SOLANA;
  const { spyLogger } = createSpyLogger();

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

  const fillEvent = (relay: RelayDataWithMessageHash): DecodedEvent<RelayEventName> => ({
    name: "FilledRelay",
    data: {
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
    },
  });

  // Exercise the real association pipeline against a stubbed event source by shadowing the private
  // queryAllEvents member at runtime. Object.create() returns `any` and Object.assign() merges the stubbed
  // members without reference to the class's private declarations, so no type assertions are needed.
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

  it("ignores fill events for other relays", async () => {
    const expected = relayData(1);
    const other = { ...expected, depositId: BigNumber.from(2) };
    const eventsClient = client([fillEvent(other), fillEvent(expected)]);

    const fill = await findFillEvent(expected, destinationChainId, eventsClient, 0, 100, spyLogger);

    expect(fill?.depositId.toString()).to.equal(expected.depositId.toString());
    expect(fill?.blockNumber).to.equal(1); // Sourced from the matching event's slot.
  });

  it("does not reconstruct fill status from another relay's event", async () => {
    const expected = relayData(1);
    const other = { ...expected, depositId: BigNumber.from(2) };

    const status = await relayFillStatus(
      program,
      expected,
      destinationChainId,
      client([fillEvent(other)]),
      spyLogger,
      100
    );
    const filled = await relayFillStatus(
      program,
      expected,
      destinationChainId,
      client([fillEvent(expected)]),
      spyLogger,
      100
    );

    expect(status).to.equal(FillStatus.Unfilled);
    expect(filled).to.equal(FillStatus.Filled);
  });
});
