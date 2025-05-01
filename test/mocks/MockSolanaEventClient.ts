import assert from "assert";
import { random } from "lodash";
import { Address, UnixTimestamp, signature } from "@solana/kit";
import { Idl } from "@coral-xyz/anchor";
import { SvmSpokeClient } from "@across-protocol/contracts";

import { SvmCpiEventsClient } from "../../src/arch/svm/eventsClient";
import { EventName, EventWithData, SVMProvider } from "../../src/arch/svm";
import { MockSolanaRpcFactory } from "./MockSolanaRpcFactory";
import { bnZero, bnOne, bs58, getCurrentTime } from "../../src/utils";
import { ethers } from "ethers";

export class MockSolanaEventClient extends SvmCpiEventsClient {
  private events: Record<EventName, EventWithData[]> = {} as Record<EventName, EventWithData[]>;
  private slotHeight: bigint;
  public minBlockRange = 10;
  public numberOfDeposits = bnZero;
  public SVM_ZERO_ADDRESS = bs58.encode(new Uint8Array(32));

  constructor(programId = "JAZWcGrpSWNPTBj8QtJ9UyQqhJCDhG9GJkDeMf5NQBiq") {
    super(null as unknown as SVMProvider, programId as Address, null as unknown as Address, null as unknown as Idl);
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

  public deposit(event: string, deposit: SvmSpokeClient.FundsDeposited & Partial<EventWithData>): EventWithData {
    const { slot } = deposit;
    let { depositId, destinationChainId, inputAmount, outputAmount } = deposit;
    depositId ??= Uint8Array.from([this.numberOfDeposits]); // double check this
    this.numberOfDeposits = this.numberOfDeposits.add(bnOne);

    destinationChainId ??= BigInt(random(1, 42161, false));
    const depositor = deposit.depositor ?? this.randomSvmAddress();
    const recipient = deposit.recipient ?? depositor;
    const inputToken = deposit.inputToken ?? this.randomSvmAddress();
    const outputToken = deposit.outputToken ?? inputToken;
    const exclusiveRelayer = deposit.exclusiveRelayer ?? this.SVM_ZERO_ADDRESS;

    inputAmount ??= BigInt(random(1, 1000, false));
    outputAmount ??= inputAmount * BigInt("0.95"); // double check this

    const message = deposit["message"] ?? "0x";
    const quoteTimestamp = deposit.quoteTimestamp ?? getCurrentTime();
    const args = {
      depositId,
      originChainId: deposit.originChainId ?? this.chainId, // fix this, why is originChainId missing from deposit?
      destinationChainId,
      depositor,
      recipient,
      inputToken,
      inputAmount,
      outputToken,
      outputAmount,
      quoteTimestamp,
      fillDeadline: deposit.fillDeadline ?? quoteTimestamp + 3600,
      exclusiveRelayer,
      exclusivityDeadline: deposit.exclusivityDeadline ?? quoteTimestamp + 600,
      message,
    };

    return this.generateEvent({
      event,
      address: this.getProgramAddress(),
      args,
      slot,
    });
  }

  public fillRelay(event: string, fill: SvmSpokeClient.FundsDeposited & Partial<EventWithData>): EventWithData {
    // TODO: implement this
  }

  public requestSlowFill(
    event: string,
    slowFillRequest: SvmSpokeClient.RequestedSlowFill & Partial<EventWithData>
  ): EventWithData {
    // TODO: implement this
  }

  protected generateEvent(inputs) {
    // TODO: set types
    // set types
    const { address, event, args } = inputs;
    let { slot } = inputs;

    // Increment the block number by at least 1, by default. The caller may override
    // to force the same block number to be used, but never a previous block number.
    slot ??= random(Number(this.slotHeight) + 1, Number(this.slotHeight) + this.minBlockRange, false);
    assert(slot >= this.slotHeight, `${slot} < ${this.slotHeight}`);
    this.slotHeight = slot;

    const generatedEvent = {
      name: event,
      slot,
      signature: signature(bs58.encode(Buffer.from(`Across-${event}-${slot}-${random(1, 100_000)}`))),
      program: address,
      data: args,
      confirmationStatus: "finalized",
      blockTime: BigInt(new Date().getTime()) as UnixTimestamp, // double check this
    };

    this.setEvents([generatedEvent]);
    return generatedEvent;
  }
}
