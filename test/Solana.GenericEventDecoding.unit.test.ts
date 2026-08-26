import {
  MessageTransmitterClient,
  MessageTransmitterIdl,
  SvmSpokeIdl,
  TokenMessengerMinterClient,
  TokenMessengerMinterIdl,
} from "@across-protocol/contracts";
import { BorshEventCoder, Idl } from "@coral-xyz/anchor";
import { signature, type ReadonlyUint8Array } from "@solana/kit";
import {
  cctpPrograms,
  decodeEvent,
  getRandomSvmAddress,
  parseEventData,
  RawDecodedEvent,
  RawEventWithData,
  SvmCpiEventsClient,
} from "../src/arch/svm";
import { expect } from "./utils";

// Decode through the legacy pipeline (generic Anchor coder + parseEventData) for differential comparison.
function legacyDecode(idl: Idl, rawEvent: string): { name: string; data: unknown } | null {
  const event = new BorshEventCoder(idl).decode(rawEvent);
  return event === null ? null : { name: event.name, data: parseEventData(event.data) };
}

function encodeEvent(idl: Idl, name: string, payload: ReadonlyUint8Array): string {
  const idlEvent = (idl.events ?? []).find((event) => event.name === name);
  if (!idlEvent) throw new Error(`${name} event not found in IDL ${idl.address}`);
  return Buffer.concat([Buffer.from(idlEvent.discriminator), Buffer.from(payload)]).toString("base64");
}

describe("SVM event decoding (non-SvmSpoke IDLs)", () => {
  // Every event defined by the CCTP IDLs must have a registered codama decoder, so that new events added by a
  // contracts bump cannot silently decode with divergent (legacy Anchor) shapes.
  it("registers a decoder for every CCTP IDL event", () => {
    const cctpIdls: Idl[] = [TokenMessengerMinterIdl, MessageTransmitterIdl];
    for (const idl of cctpIdls) {
      const program = cctpPrograms[idl.address];
      expect(program, idl.address).to.not.equal(undefined);
      const tableNames = Object.keys(program?.eventDecoders ?? {}).sort();
      const idlNames = (idl.events ?? []).map((event) => event.name).sort();
      expect(tableNames).to.deep.equal(idlNames);
    }
  });

  // A program address is retained across IDL upgrades, so the bundled decoders only apply when the caller
  // supplied the exact bundled IDL instance. A drifted CCTP IDL (here: DepositForBurn gains a trailing field)
  // must decode per the *supplied* IDL via the generic path - the bundled decoder would silently drop the new
  // field.
  it("decodes per the supplied IDL when a CCTP IDL differs from the bundled one", () => {
    const drifted: Idl = JSON.parse(JSON.stringify(TokenMessengerMinterIdl));
    const depositForBurn = (drifted.types ?? []).find((type) => type.name === "DepositForBurn");
    expect(depositForBurn).to.not.equal(undefined);
    if (depositForBurn?.type.kind === "struct" && Array.isArray(depositForBurn.type.fields)) {
      depositForBurn.type.fields.push({ name: "new_field", type: "u64" });
    }

    const payload = TokenMessengerMinterClient.getDepositForBurnEncoder().encode({
      nonce: 1n,
      burnToken: getRandomSvmAddress(),
      amount: 9n,
      depositor: getRandomSvmAddress(),
      mintRecipient: getRandomSvmAddress(),
      destinationDomain: 1,
      destinationTokenMessenger: getRandomSvmAddress(),
      destinationCaller: getRandomSvmAddress(),
    });
    const newField = Buffer.alloc(8);
    newField.writeBigUInt64LE(777n);
    const rawEvent = encodeEvent(drifted, "DepositForBurn", Buffer.concat([Buffer.from(payload), newField]));

    const decoded = decodeEvent(drifted, rawEvent);
    expect(decoded.name).to.equal("DepositForBurn");
    expect(decoded.data).to.deep.include({ newField: 777n });
  });

  // The codama decoders must produce the same consumer-visible data as the legacy Anchor + parseEventData
  // pipeline that downstream consumers (the relayer's CCTP flows) were built against.
  it("decodes DepositForBurn identically to the legacy pipeline", () => {
    const payload = TokenMessengerMinterClient.getDepositForBurnEncoder().encode({
      nonce: 42n,
      burnToken: getRandomSvmAddress(),
      amount: 123_456n,
      depositor: getRandomSvmAddress(),
      mintRecipient: getRandomSvmAddress(),
      destinationDomain: 3,
      destinationTokenMessenger: getRandomSvmAddress(),
      destinationCaller: getRandomSvmAddress(),
    });
    const rawEvent = encodeEvent(TokenMessengerMinterIdl, "DepositForBurn", payload);
    expect(decodeEvent(TokenMessengerMinterIdl, rawEvent)).to.deep.equal(
      legacyDecode(TokenMessengerMinterIdl, rawEvent)
    );
  });

  it("decodes MintAndWithdraw identically to the legacy pipeline", () => {
    const payload = TokenMessengerMinterClient.getMintAndWithdrawEncoder().encode({
      mintRecipient: getRandomSvmAddress(),
      amount: 555n,
      mintToken: getRandomSvmAddress(),
    });
    const rawEvent = encodeEvent(TokenMessengerMinterIdl, "MintAndWithdraw", payload);
    expect(decodeEvent(TokenMessengerMinterIdl, rawEvent)).to.deep.equal(
      legacyDecode(TokenMessengerMinterIdl, rawEvent)
    );
  });

  it("decodes MessageReceived identically to the legacy pipeline", () => {
    const payload = MessageTransmitterClient.getMessageReceivedEncoder().encode({
      caller: getRandomSvmAddress(),
      sourceDomain: 0,
      nonce: 7n,
      sender: getRandomSvmAddress(),
      messageBody: Uint8Array.from({ length: 64 }, (_, index) => index),
    });
    const rawEvent = encodeEvent(MessageTransmitterIdl, "MessageReceived", payload);
    expect(decodeEvent(MessageTransmitterIdl, rawEvent)).to.deep.equal(legacyDecode(MessageTransmitterIdl, rawEvent));
  });

  // Regression: SvmCpiEventsClient is IDL-parameterised and used downstream with non-SvmSpoke programs
  // (e.g. the CCTP TokenMessengerMinter). decodeEvent must decode those generically rather than rejecting
  // them or mis-decoding them with SvmSpoke layouts.
  it("decodes non-SvmSpoke events with the generic Anchor coder", () => {
    const depositor = getRandomSvmAddress();
    const payload = TokenMessengerMinterClient.getDepositForBurnEncoder().encode({
      nonce: 1n,
      burnToken: getRandomSvmAddress(),
      amount: 1_000n,
      depositor,
      mintRecipient: getRandomSvmAddress(),
      destinationDomain: 7,
      destinationTokenMessenger: getRandomSvmAddress(),
      destinationCaller: getRandomSvmAddress(),
    });

    const idlEvent = (TokenMessengerMinterIdl.events ?? []).find((event) => event.name === "DepositForBurn");
    expect(idlEvent).to.not.equal(undefined);
    const rawEvent = Buffer.concat([Buffer.from(idlEvent!.discriminator), Buffer.from(payload)]).toString("base64");

    const decoded = decodeEvent(TokenMessengerMinterIdl, rawEvent);
    expect(decoded.name).to.equal("DepositForBurn");

    // The shape the relayer consumes: base58 address strings and bigint amounts.
    expect(decoded.data).to.deep.include({ depositor, destinationDomain: 7, amount: 1_000n });
  });

  it("rejects unknown non-SvmSpoke events rather than mis-decoding them", () => {
    const bogus = Buffer.from([9, 9, 9, 9, 9, 9, 9, 9, 1]).toString("base64");
    expect(() => decodeEvent(TokenMessengerMinterIdl, bogus)).to.throw(/malformed event for IDL/);
  });

  it("continues to reject unknown SvmSpoke events", () => {
    const bogus = Buffer.from([1, 2, 3, 4, 5, 6, 7, 8, 9]).toString("base64");
    expect(() => decodeEvent(SvmSpokeIdl, bogus)).to.throw(/unknown SvmSpoke event/);
  });

  // Regression: the relayer queries CCTP events via queryDerivedAddressEvents() with plain string event
  // names (e.g. "DepositForBurn" against the message sent event PDA). Non-SvmSpoke events carry no typed
  // name, so the method must accept any event name and return raw (untyped) events.
  it("queries derived-address events for non-SvmSpoke programs by name", async () => {
    const program = getRandomSvmAddress();
    const events: RawDecodedEvent[] = [
      { name: "DepositForBurn", data: { nonce: 1n } },
      { name: "MintAndWithdraw", data: { amount: 2n } },
    ];

    // Exercise the real queryDerivedAddressEvents() implementation against a stubbed event source by
    // shadowing the private queryAllEvents member at runtime. Object.create() returns `any` and
    // Object.assign() merges the stubbed members without reference to the class's private declarations,
    // so no type assertions are needed.
    const stub: SvmCpiEventsClient = Object.create(SvmCpiEventsClient.prototype);
    Object.assign(stub, {
      queryAllEvents: (): Promise<RawEventWithData[]> =>
        Promise.resolve(
          events.map((decoded, index) => ({
            ...decoded,
            slot: BigInt(index),
            // A valid-form (all-zero-bytes) signature; the filtering logic never inspects it.
            signature: signature("1".repeat(64)),
            blockTime: null,
            confirmationStatus: "confirmed",
            program,
          }))
        ),
    });

    const matched = await stub.queryDerivedAddressEvents("DepositForBurn", getRandomSvmAddress());
    expect(matched.length).to.equal(1);
    expect(matched[0].name).to.equal("DepositForBurn");
    expect(matched[0].data).to.deep.equal({ nonce: 1n });
  });

  // queryEvents() narrows event.data by event.name, a correlation that only the generated SvmSpoke decoders
  // establish. A client bound to another IDL may emit an identically-named event with an unrelated payload,
  // so the typed query must reject it outright rather than mislabel it as an SvmSpoke event.
  it("rejects the typed query on a client bound to a non-SvmSpoke IDL", async () => {
    const rpc = {} as unknown as Parameters<typeof SvmCpiEventsClient.createFor>[0];
    const client = await SvmCpiEventsClient.createFor(rpc, getRandomSvmAddress(), TokenMessengerMinterIdl);
    await expect(client.queryEvents("FundsDeposited")).to.be.rejectedWith(/not SvmSpoke/);
  });
});
