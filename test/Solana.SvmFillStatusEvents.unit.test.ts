import { CHAIN_IDs } from "@across-protocol/constants";
import { SvmSpokeClient } from "@across-protocol/contracts";
import { address } from "@solana/kit";
import { expect } from "chai";
import { SVM_DEFAULT_ADDRESS, SVMEventNames, findFillEvent, numberToU8a32, relayFillStatus } from "../src/arch/svm";
import { MockSvmCpiEventsClient } from "../src/clients/mocks";
import { FillStatus } from "../src/interfaces";
import { EvmAddress } from "../src/utils";
import { createSpyLogger } from "./utils";
import { formatRelayData } from "./utils/svm/utils";

describe("SVM fill-status event lookup", () => {
  it("ignores fill events for another relay in a transaction that mentions the queried PDA", async () => {
    const programId = address(SvmSpokeClient.SVM_SPOKE_PROGRAM_ADDRESS);
    const eventsClient = new MockSvmCpiEventsClient(programId, CHAIN_IDs.SOLANA);
    const targetRelayData: SvmSpokeClient.RelayDataArgs = {
      depositor: address(EvmAddress.from("0x1111111111111111111111111111111111111111").toBase58()),
      recipient: address("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr"),
      exclusiveRelayer: SVM_DEFAULT_ADDRESS,
      inputToken: address(EvmAddress.from("0x2222222222222222222222222222222222222222").toBase58()),
      outputToken: address("So11111111111111111111111111111111111111112"),
      inputAmount: numberToU8a32(100),
      outputAmount: 90,
      originChainId: CHAIN_IDs.MAINNET,
      depositId: numberToU8a32(1),
      fillDeadline: 2_000_000_000,
      exclusivityDeadline: 0,
      message: new Uint8Array(),
    };
    const unrelatedRelayData = { ...targetRelayData, depositId: numberToU8a32(2) };
    const messageHash = new Uint8Array(32);

    const unrelatedFillEvent = eventsClient.fillRelay({
      ...unrelatedRelayData,
      outputAmount: BigInt(unrelatedRelayData.outputAmount),
      messageHash,
      slot: 1n,
    } as unknown as SvmSpokeClient.FilledRelay & { slot: bigint });
    const unrelatedSlowFillEvent = eventsClient.requestSlowFill({
      ...unrelatedRelayData,
      outputAmount: BigInt(unrelatedRelayData.outputAmount),
      messageHash,
      slot: 2n,
    } as unknown as SvmSpokeClient.RequestedSlowFill & { slot: bigint });
    const targetSlowFillEvent = eventsClient.requestSlowFill({
      ...targetRelayData,
      outputAmount: BigInt(targetRelayData.outputAmount),
      messageHash,
      slot: 3n,
    } as unknown as SvmSpokeClient.RequestedSlowFill & { slot: bigint });
    const targetFillEvent = eventsClient.fillRelay({
      ...targetRelayData,
      outputAmount: BigInt(targetRelayData.outputAmount),
      messageHash,
      slot: 4n,
    } as unknown as SvmSpokeClient.FilledRelay & { slot: bigint });

    eventsClient.queryDerivedAddressEvents = (eventName, _derivedAddress, fromSlot, toSlot) => {
      const events =
        eventName === SVMEventNames.FilledRelay
          ? [unrelatedFillEvent, targetFillEvent]
          : [unrelatedSlowFillEvent, targetSlowFillEvent];
      return Promise.resolve(
        events.filter((event) => (!fromSlot || event.slot >= fromSlot) && (!toSlot || event.slot <= toSlot))
      );
    };

    const relayData = formatRelayData(targetRelayData);
    const fill = await findFillEvent(relayData, CHAIN_IDs.SOLANA, eventsClient, 0, 10);
    expect(fill?.depositId.eq(relayData.depositId)).to.be.true;

    const statusBeforeTargetEvents = await relayFillStatus(
      programId,
      relayData,
      CHAIN_IDs.SOLANA,
      eventsClient,
      createSpyLogger().spyLogger,
      2
    );
    expect(statusBeforeTargetEvents).to.equal(FillStatus.Unfilled);

    const requestedSlowFillStatus = await relayFillStatus(
      programId,
      relayData,
      CHAIN_IDs.SOLANA,
      eventsClient,
      createSpyLogger().spyLogger,
      3
    );
    expect(requestedSlowFillStatus).to.equal(FillStatus.RequestedSlowFill);

    const filledStatus = await relayFillStatus(
      programId,
      relayData,
      CHAIN_IDs.SOLANA,
      eventsClient,
      createSpyLogger().spyLogger,
      4
    );
    expect(filledStatus).to.equal(FillStatus.Filled);
  });
});
