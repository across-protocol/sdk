import { Address } from "@solana/kit";
import { SvmCpiEventsClient } from "../../src/arch/svm/eventsClient";
import { Idl } from "@coral-xyz/anchor";
import { EventName, EventWithData, SVMProvider } from "../../src/arch/svm";
import { MockSolanaRpcFactory } from "./MockSolanaRpcFactory";

export class MockSolanaEventClient extends SvmCpiEventsClient {
  private events: Record<EventName, EventWithData[]> = {} as Record<EventName, EventWithData[]>;
  private slotHeight: bigint;

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
}
