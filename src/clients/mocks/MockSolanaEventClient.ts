import assert from "assert";
import { createHash } from "crypto";
import { hexlify, arrayify, hexZeroPad } from "ethers/lib/utils";
import { random } from "lodash";
import { Address, UnixTimestamp, signature } from "@solana/kit";
import { Idl } from "@coral-xyz/anchor";
import { SvmSpokeClient } from "@across-protocol/contracts";
import { CHAIN_IDs } from "@across-protocol/constants";

import { MockSolanaRpcFactory } from "../../providers/mocks";
import {
  SVM_DEFAULT_ADDRESS,
  EventName,
  EventWithData,
  SvmCpiEventsClient,
  SVMEventNames,
  SVMProvider,
  getRandomSvmAddress,
} from "../../arch/svm";
import { bnZero, bnOne, bs58, getCurrentTime, randomAddress, EvmAddress } from "../../utils";
import { FillType } from "../../interfaces";

export class MockSolanaEventClient extends SvmCpiEventsClient {
  private events: Record<EventName, EventWithData[]> = {} as Record<EventName, EventWithData[]>;
  private slotHeight: bigint = BigInt(0);
  public chainId: number;
  public minBlockRange = 10;
  public numberOfDeposits = bnZero;

  constructor(programId = SvmSpokeClient.SVM_SPOKE_PROGRAM_ADDRESS, chainId = CHAIN_IDs.SOLANA) {
    super(null as unknown as SVMProvider, programId as Address, null as unknown as Address, null as unknown as Idl);
    this.chainId = chainId;
  }

  public setSlotHeight(slotHeight: bigint) {
    this.slotHeight = slotHeight;
  }

  public setEvents(events: EventWithData[]) {
    for (const event of events) {
      this.events[event.name as EventName] ??= [];
      this.events[event.name as EventName].push(event);
    }
    const maxSlot = Math.max(...events.map((event) => Number(event.slot)));
    this.setSlotHeight(BigInt(maxSlot) + BigInt(1));
  }

  public clearEvents(name?: EventName) {
    if (name) {
      this.events[name] = [];
    } else {
      this.events = {} as Record<EventName, EventWithData[]>;
    }
  }

  public override queryEvents(eventName: EventName, fromSlot?: bigint, toSlot?: bigint): Promise<EventWithData[]> {
    return Promise.resolve(
      this.events[eventName]?.filter(
        (event) => (!fromSlot || event.slot >= fromSlot) && (!toSlot || event.slot <= toSlot)
      ) ?? []
    );
  }

  public override getRpc(): SVMProvider {
    const client = new MockSolanaRpcFactory("https://test.com", 1234567890);
    client.setResult("getSlot", [], this.slotHeight);
    return client.createRpcClient();
  }

  public deposit(deposit: SvmSpokeClient.FundsDeposited & Partial<EventWithData>): EventWithData {
    const { slot } = deposit;
    let { depositId, destinationChainId, inputAmount, outputAmount } = deposit;
    depositId ??= arrayify(hexZeroPad(hexlify(random(1, 100_000, false)), 32));
    this.numberOfDeposits = this.numberOfDeposits.add(bnOne);

    destinationChainId ??= BigInt(random(1, 42161, false));
    const depositor = deposit.depositor ?? getRandomSvmAddress();
    const recipient = deposit.recipient ?? EvmAddress.from(randomAddress()).toBase58();
    const inputToken = deposit.inputToken ?? getRandomSvmAddress();
    const outputToken = deposit.outputToken ?? EvmAddress.from(randomAddress()).toBase58();
    inputAmount ??= BigInt(random(1, 1000, false));
    outputAmount ??= (inputAmount * BigInt(95)) / BigInt(100);
    const message = deposit.message ?? new Uint8Array(32);
    const quoteTimestamp = deposit.quoteTimestamp ?? getCurrentTime();

    const args = {
      depositId,
      destinationChainId,
      depositor,
      recipient,
      inputToken,
      inputAmount,
      outputToken,
      outputAmount,
      quoteTimestamp,
      fillDeadline: deposit.fillDeadline ?? quoteTimestamp + 3600,
      exclusiveRelayer: deposit.exclusiveRelayer ?? SVM_DEFAULT_ADDRESS,
      exclusivityDeadline: deposit.exclusivityDeadline ?? quoteTimestamp + 600,
      message,
    };

    return this.generateEvent({
      event: SVMEventNames.FundsDeposited,
      address: this.getProgramAddress(),
      args,
      slot,
    });
  }

  public fillRelay(fill: SvmSpokeClient.FilledRelay & Partial<EventWithData>): EventWithData {
    const { slot } = fill;
    let { depositId, inputAmount, outputAmount, fillDeadline } = fill;
    depositId ??= arrayify(hexZeroPad(hexlify(random(1, 100_000, false)), 32));
    inputAmount ??= BigInt(random(1, 1000, false));
    outputAmount ??= (inputAmount * BigInt(95)) / BigInt(100);
    fillDeadline ??= getCurrentTime() + 60;

    const depositor = fill.depositor ?? EvmAddress.from(randomAddress()).toBase58();
    const recipient = fill.recipient ?? getRandomSvmAddress();
    const inputToken = fill.inputToken ?? EvmAddress.from(randomAddress()).toBase58();
    const outputToken = fill.outputToken ?? getRandomSvmAddress();
    const messageHash = fill.messageHash ?? new Uint8Array(32);

    const relayExecutionInfo = {
      updatedRecipient: fill.relayExecutionInfo?.updatedRecipient ?? recipient,
      updatedOutputAmount: fill.relayExecutionInfo?.updatedOutputAmount ?? outputAmount,
      fillType: fill.relayExecutionInfo?.fillType ?? FillType.FastFill,
      updatedMessageHash: fill.relayExecutionInfo?.updatedMessageHash ?? messageHash,
    };

    const args = {
      depositId,
      originChainId: fill.originChainId ?? BigInt(random(1, 42161, false)),
      depositor,
      recipient,
      inputToken,
      inputAmount,
      outputToken,
      outputAmount,
      fillDeadline,
      exclusiveRelayer: fill.exclusiveRelayer ?? SVM_DEFAULT_ADDRESS,
      exclusivityDeadline: fill.exclusivityDeadline ?? fillDeadline,
      relayer: fill.relayer ?? getRandomSvmAddress(),
      messageHash,
      relayExecutionInfo,
    };

    return this.generateEvent({
      event: SVMEventNames.FilledRelay,
      address: this.getProgramAddress(),
      args,
      slot,
    });
  }

  public requestSlowFill(slowFillRequest: SvmSpokeClient.RequestedSlowFill & Partial<EventWithData>): EventWithData {
    const { slot } = slowFillRequest;
    let { depositId, originChainId } = slowFillRequest;
    depositId ??= Uint8Array.from([random(1, 100_000, false)]);
    originChainId ??= BigInt(random(1, 42161, false));
    const depositor = slowFillRequest.depositor ?? EvmAddress.from(randomAddress()).toBase58();
    const recipient = slowFillRequest.recipient ?? getRandomSvmAddress();
    const inputToken = slowFillRequest.inputToken ?? EvmAddress.from(randomAddress()).toBase58();
    const outputToken = slowFillRequest.outputToken ?? getRandomSvmAddress();

    const args = {
      ...slowFillRequest,
      depositId,
      originChainId,
      depositor,
      recipient,
      inputToken,
      outputToken,
      inputAmount: slowFillRequest.inputAmount ?? BigInt(random(1, 1000, false)),
      outputAmount: slowFillRequest.outputAmount ?? slowFillRequest.inputAmount ?? BigInt(random(1, 1000, false)),
      exclusiveRelayer: slowFillRequest.exclusiveRelayer ?? SVM_DEFAULT_ADDRESS,
    };

    return this.generateEvent({
      event: SVMEventNames.RequestedSlowFill,
      address: this.getProgramAddress(),
      args,
      slot,
    });
  }

  protected generateEvent(inputs: {
    address: Address;
    event: EventName;
    args: Record<string, unknown>;
    slot?: bigint;
  }) {
    // TODO: set types
    const { address, event, args } = inputs;
    let { slot } = inputs;

    const randomSlotWithinRange = () =>
      random(Number(this.slotHeight) + 1, Number(this.slotHeight) + this.minBlockRange, false);

    // Increment the slot number by at least 1, by default. The caller may override
    // to force the same slot number to be used, but never a previous slot number.
    slot ??= BigInt(randomSlotWithinRange());
    assert(slot >= this.slotHeight, `${slot} < ${this.slotHeight}`);
    this.slotHeight = slot;

    const generatedEvent = {
      name: event,
      slot,
      signature: signature(
        bs58.encode(
          Uint8Array.from(
            createHash("sha512")
              .update(`Across-${event}-${slot}-${random(1, 100_000)}`)
              .digest()
          )
        )
      ),
      program: address,
      data: args,
      confirmationStatus: "finalized",
      blockTime: BigInt(new Date().getTime()) as UnixTimestamp,
    };

    this.setEvents([generatedEvent]);
    return generatedEvent;
  }
}
