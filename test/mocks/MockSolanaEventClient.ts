import assert from "assert";
import { ethers } from "ethers";
import { createHash } from "crypto";
import { random } from "lodash";
import { Address, UnixTimestamp, signature } from "@solana/kit";
import { Idl } from "@coral-xyz/anchor";
import { SvmSpokeClient } from "@across-protocol/contracts";
import { CHAIN_IDs } from "@across-protocol/constants";

import { MockSolanaRpcFactory } from "./MockSolanaRpcFactory";
import { SvmCpiEventsClient } from "../../src/arch/svm/eventsClient";
import { EventName, EventWithData, SVMEventNames, SVMProvider } from "../../src/arch/svm";
import { bnZero, bnOne, bs58, getCurrentTime } from "../../src/utils";
import { FillType } from "../../src/interfaces";

export class MockSolanaEventClient extends SvmCpiEventsClient {
  private events: Record<EventName, EventWithData[]> = {} as Record<EventName, EventWithData[]>;
  private slotHeight: bigint;
  public chainId: number;
  public minBlockRange = 10;
  public numberOfDeposits = bnZero;
  public SVM_ZERO_ADDRESS = bs58.encode(new Uint8Array(32));

  constructor(programId = "JAZWcGrpSWNPTBj8QtJ9UyQqhJCDhG9GJkDeMf5NQBiq", chainId = CHAIN_IDs.SOLANA) {
    super(null as unknown as SVMProvider, programId as Address, null as unknown as Address, null as unknown as Idl);
    this.chainId = this.chainId;
  }

  public setSlotHeight(slotHeight: bigint) {
    this.slotHeight = slotHeight;
  }

  public setEvents(events: EventWithData[]) {
    for (const event of events) {
      this.events[event.name] ??= [];
      this.events[event.name].push(event);
    }
    const maxSlot = Math.max(...events.map((event) => Number(event.slot)));
    this.setSlotHeight(BigInt(maxSlot) + 1n);
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

  randomSvmAddress(): string {
    return bs58.encode(ethers.utils.randomBytes(32));
  }

  public deposit(deposit: SvmSpokeClient.FundsDeposited & Partial<EventWithData>): EventWithData {
    const { slot } = deposit;
    let { depositId, destinationChainId, inputAmount, outputAmount } = deposit;
    depositId ??= Uint8Array.from([this.numberOfDeposits]);
    this.numberOfDeposits = this.numberOfDeposits.add(bnOne);

    destinationChainId ??= BigInt(random(1, 42161, false));
    const depositor = deposit.depositor ?? this.randomSvmAddress();
    const recipient = deposit.recipient ?? depositor;
    const inputToken = deposit.inputToken ?? this.randomSvmAddress();
    const outputToken = deposit.outputToken ?? inputToken;
    inputAmount ??= BigInt(random(1, 1000, false));
    outputAmount ??= (inputAmount * 95n) / 100n;
    const message = deposit.message ?? Uint8Array.from("0x");
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
      exclusiveRelayer: deposit.exclusiveRelayer ?? this.SVM_ZERO_ADDRESS,
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
    depositId ??= Uint8Array.from([random(1, 100_000, false)]);
    inputAmount ??= BigInt(random(1, 1000, false));
    outputAmount ??= (inputAmount * 95n) / 100n;
    fillDeadline ??= getCurrentTime() + 60;

    const depositor = fill.depositor ?? this.randomSvmAddress();
    const recipient = fill.recipient ?? depositor;
    const inputToken = fill.inputToken ?? this.randomSvmAddress();
    const outputToken = fill.outputToken ?? inputToken;
    const messageHash = fill.messageHash ?? Uint8Array.from("0x");

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
      exclusiveRelayer: fill.exclusiveRelayer ?? this.SVM_ZERO_ADDRESS,
      exclusivityDeadline: fill.exclusivityDeadline ?? fillDeadline,
      relayer: fill.relayer ?? this.randomSvmAddress(),
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
    depositId ??= Uint8Array.from([random(1, 100_000, false)]); // double check this
    originChainId ??= BigInt(random(1, 42161, false));
    const depositor = slowFillRequest.depositor ?? this.randomSvmAddress();

    const args = {
      ...slowFillRequest,
      depositId,
      originChainId,
      depositor,
      recipient: slowFillRequest.recipient ?? depositor,
      inputToken: slowFillRequest.inputToken ?? this.randomSvmAddress(),
      outputToken: slowFillRequest.outputToken ?? slowFillRequest.inputToken ?? this.randomSvmAddress(),
      inputAmount: slowFillRequest.inputAmount ?? BigInt(random(1, 1000, false)),
      outputAmount: slowFillRequest.outputAmount ?? slowFillRequest.inputAmount ?? BigInt(random(1, 1000, false)),
      exclusiveRelayer: slowFillRequest.exclusiveRelayer ?? this.SVM_ZERO_ADDRESS,
    };

    return this.generateEvent({
      event: SVMEventNames.RequestedSlowFill,
      address: this.getProgramAddress(),
      args,
      slot,
    });
  }

  protected generateEvent(inputs) {
    // TODO: set types
    const { address, event, args } = inputs;
    let { slot } = inputs;

    // Increment the slot number by at least 1, by default. The caller may override
    // to force the same slot number to be used, but never a previous slot number.
    slot ??= random(Number(this.slotHeight) + 1, Number(this.slotHeight) + this.minBlockRange, false);
    assert(slot >= this.slotHeight, `${slot} < ${this.slotHeight}`);
    this.slotHeight = slot;

    const generatedEvent = {
      name: event,
      slot,
      signature: signature(
        bs58.encode(
          createHash("sha512")
            .update(`Across-${event}-${slot}-${random(1, 100_000)}`)
            .digest()
        )
      ),
      program: address,
      data: args,
      confirmationStatus: "finalized",
      blockTime: BigInt(new Date().getTime()) as UnixTimestamp, // double check this
    };

    this.setEvents([generatedEvent]);
    return generatedEvent;
  }
}
