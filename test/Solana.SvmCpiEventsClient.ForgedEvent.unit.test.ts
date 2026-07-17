import { SvmSpokeIdl } from "@across-protocol/contracts";
import { expect } from "chai";
import bs58 from "bs58";
import { SvmCpiEventsClient } from "../src/arch/svm";

/**
 * Regression test for forged SVM CPI events.
 *
 * Anchor emits CPI events as a self-invocation of the program that targets its `__event_authority`
 * PDA, with the instruction data prefixed by the 8-byte Anchor event discriminator
 * (`e445a52e51cb9a1d`). `SvmCpiEventsClient` must only decode an inner instruction as an event when
 * that prefix is present. Otherwise any program can forge a `FundsDeposited` event by CPI-ing into
 * the SpokePool with the event authority passed as the sole account and attacker-controlled trailing
 * bytes — which is exactly what was observed on mainnet (e.g. tx
 * 3rLkGVvyYL2LTuDzbo8MBYNwjhYaKo1pEoqd24HCPQJEhNgyVnKZeNFsFrStKYY6cVizBfLpa2RMiB8dxHPzGHMV), where a
 * wrapper program CPI'd into the read-only `GetUnsafeDepositId` instruction to fake ~$4.1M deposits
 * that never escrowed any funds.
 */
describe("SvmCpiEventsClient (forged event rejection)", () => {
  // Mainnet SvmSpoke program.
  const PROGRAM = "DLv3NggMiSaef97YCkew5xKUHDh13tVGZ7tydt3ZeAru";

  // The Anchor CPI event discriminator (prefix of a genuine emitted event).
  const ANCHOR_EVENT_DISCRIMINATOR = Buffer.from([0xe4, 0x45, 0xa5, 0x2e, 0x51, 0xcb, 0x9a, 0x1d]);
  // Discriminator of the read-only `get_unsafe_deposit_id` instruction the attacker abused.
  const GET_UNSAFE_DEPOSIT_ID_DISCRIMINATOR = Buffer.from([0x76, 0x0a, 0x87, 0x00, 0xa8, 0xf3, 0xdf, 0x75]);

  // Real bytes captured from the mainnet exploit tx: the 8-byte FundsDeposited event discriminator
  // followed by the Borsh-encoded (attacker-crafted) event payload — i.e. the data that follows the
  // 8-byte instruction prefix. Reused verbatim for both cases so the *only* difference is the prefix.
  const eventDiscriminatorAndBody = Buffer.from(
    "9dd1645f3b640344c6fa7af3bedbad3a3d65f36aabc97431b1bbe4c2d2f6e0e47ca60203452f5d61" +
      "000000000000000000000000a0b86991c6218b36c1d19d4a2e9eb0ce3606eb4859df7cd6bd0300000000" +
      "0000000000000000000000000000000000000000000000000003b42aa2a336010000000000000000000000" +
      "0000000000000000000000000000000000000000000000000088c48a2ec190c8b8596a1ec7596a00000000" +
      "0066f4dd792ef4ba76f0427abfe89e2a7366dbc8f6543bdcb48018be9578ef6879000000000000000000000000" +
      "a6fb971f3b7a9b9f76eda76bc89268fe26560189000000000000000000000000000000000000000000000000" +
      "000000000000000000000000",
    "hex"
  );

  let client: SvmCpiEventsClient;
  // Access the private members exercised by this test without widening to `any`.
  let internal: {
    programEventAuthority: string;
    processEventFromTx(txResult: unknown): { name: string }[];
  };

  before(async () => {
    // createFor only uses the rpc to construct the instance; PDA derivation is local, so a stub is fine.
    const rpc = {} as unknown as Parameters<typeof SvmCpiEventsClient.createFor>[0];
    client = await SvmCpiEventsClient.createFor(rpc, PROGRAM, SvmSpokeIdl);
    internal = client as unknown as typeof internal;
  });

  const makeTx = (instructionPrefix: Buffer) => ({
    meta: {
      err: null,
      loadedAddresses: { writable: [], readonly: [] },
      innerInstructions: [
        {
          index: 0,
          instructions: [
            {
              programIdIndex: 0,
              accounts: [1],
              data: bs58.encode(Buffer.concat([instructionPrefix, eventDiscriminatorAndBody])),
            },
          ],
        },
      ],
    },
    transaction: {
      message: { accountKeys: [client.getProgramAddress(), internal.programEventAuthority] },
    },
  });

  it("decodes a genuine emitted event (Anchor event discriminator prefix)", () => {
    const events = internal.processEventFromTx(makeTx(ANCHOR_EVENT_DISCRIMINATOR));
    expect(events.map((e) => e.name)).to.deep.equal(["FundsDeposited"]);
  });

  it("ignores a forged event emitted via an arbitrary CPI into the program", () => {
    const events = internal.processEventFromTx(makeTx(GET_UNSAFE_DEPOSIT_ID_DISCRIMINATOR));
    expect(events).to.have.lengthOf(0);
  });
});
