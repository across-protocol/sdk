import { CHAIN_IDs } from "@across-protocol/constants";
import { address } from "@solana/kit";
import { arrayify } from "ethers/lib/utils";
import { findFillEvent, getRandomSvmAddress, relayFillStatus, SvmCpiEventsClient } from "../src/arch/svm";
import { FillStatus, RelayDataWithMessageHash } from "../src/interfaces";
import { BigNumber, getRelayEventKey, randomAddress, toAddressType } from "../src/utils";
import { createSpyLogger, expect } from "./utils";

/**
 * Regression test for fillStatus PDA / event association.
 *
 * `SvmCpiEventsClient.queryDerivedAddressEvents` returns *every* SpokePool event emitted by a
 * transaction that merely references the supplied fillStatus PDA — it does not check that each event's
 * relay data actually derives that PDA. A caller can cheaply reference an unrelated fillStatus PDA from a
 * transaction that fills a *different* relay (or emits several fills in one transaction). Downstream code
 * assumed the opposite:
 *   - `findFillEvent` asserts `fillEvents.length <= 1`, and its result feeds
 *     `assert(getRelayEventKey(prefill) === relayDataHash)` in the bundle data client;
 *   - `relayFillStatus` (via event reconstruction) infers Filled/RequestedSlowFill from the events.
 * Either could be corrupted by a foreign fill attached to the PDA, crashing bundle proposal for every
 * chain. `findFillEvent` and the event-reconstruction path must therefore drop events whose relay data
 * does not derive the queried PDA.
 */
describe("SVM fillStatus PDA / event association", () => {
  // Mainnet SvmSpoke program; PDA derivation is local so a stub RPC is fine.
  const PROGRAM = address("DLv3NggMiSaef97YCkew5xKUHDh13tVGZ7tydt3ZeAru");
  const originChainId = CHAIN_IDs.MAINNET; // EVM origin
  const destinationChainId = CHAIN_IDs.SOLANA; // SVM destination
  const { spyLogger } = createSpyLogger();

  const svmAddr = () => toAddressType(getRandomSvmAddress(), destinationChainId);
  const evmAddr = () => toAddressType(randomAddress(), originChainId);

  const makeRelayData = (overrides: Partial<RelayDataWithMessageHash> = {}): RelayDataWithMessageHash => ({
    originChainId,
    depositor: evmAddr(),
    recipient: svmAddr(),
    inputToken: evmAddr(),
    outputToken: svmAddr(),
    inputAmount: BigNumber.from(1_000),
    outputAmount: BigNumber.from(900),
    depositId: BigNumber.from(12_345),
    fillDeadline: 1_893_456_000,
    exclusivityDeadline: 0,
    exclusiveRelayer: svmAddr(),
    message: "0x",
    messageHash: "0x" + "12".repeat(32),
    ...overrides,
  });

  // Builds the raw (pre-`unwrapEventData`) shape of a genuine FilledRelay event carrying `relayData`.
  const buildRawFilledRelayEvent = (relayData: RelayDataWithMessageHash) => ({
    depositor: relayData.depositor.toBase58(),
    recipient: relayData.recipient.toBase58(),
    exclusiveRelayer: relayData.exclusiveRelayer.toBase58(),
    inputToken: relayData.inputToken.toBase58(),
    outputToken: relayData.outputToken.toBase58(),
    inputAmount: relayData.inputAmount.toBigInt(),
    outputAmount: relayData.outputAmount.toBigInt(),
    originChainId: BigInt(relayData.originChainId),
    depositId: relayData.depositId.toBigInt(),
    fillDeadline: relayData.fillDeadline,
    exclusivityDeadline: relayData.exclusivityDeadline,
    messageHash: arrayify(relayData.messageHash),
    relayer: relayData.exclusiveRelayer.toBase58(),
    repaymentChainId: BigInt(destinationChainId),
    relayExecutionInfo: {
      updatedRecipient: relayData.recipient.toBase58(),
      updatedMessageHash: arrayify(relayData.messageHash),
      updatedOutputAmount: relayData.outputAmount.toBigInt(),
      fillType: { FastFill: {} },
    },
  });

  // A stub events client whose queryDerivedAddressEvents returns the supplied fill events verbatim,
  // simulating foreign fills that a transaction attached to the queried PDA.
  const stubClient = (relayDatas: RelayDataWithMessageHash[]) => {
    const events = relayDatas.map((relayData, idx) => ({
      name: "FilledRelay",
      data: buildRawFilledRelayEvent(relayData),
      slot: BigInt(100 + idx),
      signature: `sig-${idx}`,
      blockTime: 0,
      confirmationStatus: "confirmed",
      program: PROGRAM,
    }));
    return {
      getProgramAddress: () => PROGRAM,
      getRpc: () => ({}),
      queryDerivedAddressEvents: (eventName: string) => Promise.resolve(events.filter((e) => e.name === eventName)),
    } as unknown as SvmCpiEventsClient;
  };

  const expectedKey = (relayData: RelayDataWithMessageHash) => getRelayEventKey({ ...relayData, destinationChainId });

  describe("findFillEvent", () => {
    it("returns the fill when only the genuine event is present", async () => {
      const relayData = makeRelayData();
      const fill = await findFillEvent(relayData, destinationChainId, stubClient([relayData]), 0, 1_000, spyLogger);
      expect(fill).to.not.be.undefined;
      expect(getRelayEventKey(fill!)).to.equal(expectedKey(relayData));
    });

    it("ignores a foreign fill attached to the PDA and returns the genuine fill", async () => {
      const relayData = makeRelayData();
      const foreign = makeRelayData({ depositId: BigNumber.from(99_999), depositor: evmAddr() });
      const fill = await findFillEvent(
        relayData,
        destinationChainId,
        stubClient([foreign, relayData]),
        0,
        1_000,
        spyLogger
      );
      expect(fill).to.not.be.undefined;
      expect(getRelayEventKey(fill!)).to.equal(expectedKey(relayData));
    });

    it("does not trip the <= 1 assertion when multiple foreign fills are attached to the PDA", async () => {
      const relayData = makeRelayData();
      const foreignA = makeRelayData({ depositId: BigNumber.from(1) });
      const foreignB = makeRelayData({ depositId: BigNumber.from(2) });
      const fill = await findFillEvent(
        relayData,
        destinationChainId,
        stubClient([foreignA, foreignB, relayData]),
        0,
        1_000,
        spyLogger
      );
      expect(fill).to.not.be.undefined;
      expect(getRelayEventKey(fill!)).to.equal(expectedKey(relayData));
    });

    it("returns undefined when only foreign fills are attached to the PDA", async () => {
      const relayData = makeRelayData();
      const foreignA = makeRelayData({ depositId: BigNumber.from(1) });
      const foreignB = makeRelayData({ depositId: BigNumber.from(2) });
      const fill = await findFillEvent(
        relayData,
        destinationChainId,
        stubClient([foreignA, foreignB]),
        0,
        1_000,
        spyLogger
      );
      expect(fill).to.be.undefined;
    });
  });

  describe("relayFillStatus (event reconstruction)", () => {
    // Passing an explicit slot forces the event-reconstruction path instead of a live PDA account read.
    const atHeight = 500;

    it("reports Filled for the genuine fill", async () => {
      const relayData = makeRelayData();
      const status = await relayFillStatus(
        PROGRAM,
        relayData,
        destinationChainId,
        stubClient([relayData]),
        spyLogger,
        atHeight
      );
      expect(status).to.equal(FillStatus.Filled);
    });

    it("reports Unfilled when only a foreign fill is attached to the PDA", async () => {
      const relayData = makeRelayData();
      const foreign = makeRelayData({ depositId: BigNumber.from(99_999) });
      const status = await relayFillStatus(
        PROGRAM,
        relayData,
        destinationChainId,
        stubClient([foreign]),
        spyLogger,
        atHeight
      );
      expect(status).to.equal(FillStatus.Unfilled);
    });

    it("reports Filled for the genuine fill even when a foreign fill is also attached", async () => {
      const relayData = makeRelayData();
      const foreign = makeRelayData({ depositId: BigNumber.from(99_999) });
      const status = await relayFillStatus(
        PROGRAM,
        relayData,
        destinationChainId,
        stubClient([foreign, relayData]),
        spyLogger,
        atHeight
      );
      expect(status).to.equal(FillStatus.Filled);
    });
  });
});
