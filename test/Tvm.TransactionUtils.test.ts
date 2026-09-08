import { PopulatedTransaction, utils as ethersUtils } from "ethers";
import { TronWeb } from "tronweb";
import { isTronBroadcastError, submitTransaction, TronBroadcastError } from "../src/arch/tvm";
import { assertPromiseError, expect } from "./utils";

// EVM-format addresses and their Base58 equivalents. TRON encodes an address as the 20-byte EVM
// address prefixed with 0x41, base58check-encoded.
const RECIPIENT = "0xf7bAc63fc7CEaCf0589F25454Ecf5C2ce904997c";
const RECIPIENT_BASE58 = "TYZ5ekizCPH4QdsnMfqQUFXBLtsuTuUKjJ";
const OWNER_BASE58 = "TQ42TumxqaP1gHs216UA9u36soVdza4T5Y";

const TXID = "3b699036b64d765dea6a9103c33793d343381bab361b3e96051e56de2d174247";
const FEE_LIMIT = 100_000_000;
const CALLDATA = "0xdeadbeef";

type Transfer = { to: string; amount: number; owner: string };
type ContractCall = { to: string; selector: string; options: Record<string, unknown>; owner: string };
// `code` is widened to accept a number: TronWeb's typings declare the numeric enum, even though a
// TRON HTTP node returns the name.
type BroadcastResponse = { result?: boolean; txid?: string; code?: string | number; message?: string };

type FakeTronWeb = {
  tronWeb: TronWeb;
  transfers: Transfer[];
  contractCalls: ContractCall[];
  signed: string[];
};

/** TRON hex-encodes the rejection reason on a broadcast response. */
const hexEncode = (message: string) => ethersUtils.hexlify(ethersUtils.toUtf8Bytes(message)).slice(2);

/**
 * A TronWeb instance that records what was submitted instead of broadcasting it. `broadcast` is the
 * response returned to both submission paths, permitting a failed or txid-less broadcast; supply an
 * Error instead to make the send itself throw.
 */
function fakeTronWeb(broadcast: BroadcastResponse | Error = { result: true, txid: TXID }): FakeTronWeb {
  const transfers: Transfer[] = [];
  const contractCalls: ContractCall[] = [];
  const signed: string[] = [];

  const tronWeb = {
    defaultAddress: { base58: OWNER_BASE58 },
    transactionBuilder: {
      triggerSmartContract: (
        to: string,
        selector: string,
        options: Record<string, unknown>,
        _: unknown[],
        owner: string
      ) => {
        contractCalls.push({ to, selector, options, owner });
        return Promise.resolve({ result: { result: true }, transaction: { txID: TXID } });
      },
      sendTrx: (to: string, amount: number, owner: string) => {
        transfers.push({ to, amount, owner });
        return Promise.resolve({ txID: TXID });
      },
    },
    trx: {
      sign: (txn: { txID: string }) => {
        signed.push(txn.txID);
        return Promise.resolve(txn);
      },
      sendRawTransaction: (signedTx: { txID: string }) =>
        broadcast instanceof Error
          ? Promise.reject(broadcast)
          : Promise.resolve({ ...broadcast, transaction: signedTx }),
    },
  } as unknown as TronWeb;

  return { tronWeb, transfers, contractCalls, signed };
}

describe("TVM TransactionUtils", function () {
  describe("submitTransaction", function () {
    it("Transfers TRX when the transaction has no calldata", async function () {
      const { tronWeb, transfers, contractCalls, signed } = fakeTronWeb();
      const callValue = 1_500_000; // 1.5 TRX in SUN.

      const result = await submitTransaction(tronWeb, { to: RECIPIENT } as PopulatedTransaction, FEE_LIMIT, callValue);

      // A transfer is a TransferContract, not a TriggerSmartContract, and pays bandwidth rather
      // than energy - so no fee limit is involved.
      expect(transfers).to.deep.equal([{ to: RECIPIENT_BASE58, amount: callValue, owner: OWNER_BASE58 }]);
      expect(contractCalls).to.deep.equal([]);
      // Built, signed and broadcast as discrete steps, so the txid predates the broadcast.
      expect(signed).to.deep.equal([TXID]);
      expect(result).to.deep.equal({ txid: TXID, result: true });
    });

    // "0x" is TronWeb's encoding for a `receive`/`fallback` selector, so empty-but-present calldata
    // is a contract call, not a transfer: a TransferContract would move the TRX without running the
    // recipient's code. Only an absent `data` field selects the transfer path.
    it("Treats explicit empty calldata as a fallback contract call", async function () {
      const { tronWeb, transfers, contractCalls } = fakeTronWeb();

      const populatedTx = { to: RECIPIENT, data: "0x" } as PopulatedTransaction;
      await submitTransaction(tronWeb, populatedTx, FEE_LIMIT, 1);

      expect(transfers).to.deep.equal([]);
      expect(contractCalls.length).to.equal(1);
      const [contractCall] = contractCalls;
      expect(contractCall.to).to.equal(RECIPIENT_BASE58);
      expect(contractCall.options).to.deep.equal({ feeLimit: FEE_LIMIT, input: "", callValue: 1 });
    });

    it("Submits a zero-value fallback call rather than rejecting it", async function () {
      const { tronWeb, transfers, contractCalls } = fakeTronWeb();

      const populatedTx = { to: RECIPIENT, data: "0x" } as PopulatedTransaction;
      const result = await submitTransaction(tronWeb, populatedTx, FEE_LIMIT, 0);

      expect(transfers).to.deep.equal([]);
      expect(contractCalls.length).to.equal(1);
      expect(contractCalls[0].options).to.deep.equal({ feeLimit: FEE_LIMIT, input: "", callValue: 0 });
      expect(result).to.deep.equal({ txid: TXID, result: true });
    });

    it("Submits calldata as a contract call", async function () {
      const { tronWeb, transfers, contractCalls } = fakeTronWeb();

      const populatedTx = { to: RECIPIENT, data: CALLDATA } as PopulatedTransaction;
      const result = await submitTransaction(tronWeb, populatedTx, FEE_LIMIT, 0);

      expect(transfers).to.deep.equal([]);
      expect(contractCalls.length).to.equal(1);
      const [contractCall] = contractCalls;
      expect(contractCall.to).to.equal(RECIPIENT_BASE58);
      expect(contractCall.owner).to.equal(OWNER_BASE58);
      // The full calldata is supplied via `input`, so the function selector is empty.
      expect(contractCall.selector).to.equal("");
      expect(contractCall.options).to.deep.equal({ feeLimit: FEE_LIMIT, input: CALLDATA.slice(2), callValue: 0 });
      expect(result).to.deep.equal({ txid: TXID, result: true });
    });

    it("Rejects a transaction with neither calldata nor value", async function () {
      const { tronWeb, transfers } = fakeTronWeb();

      const populatedTx = { to: RECIPIENT } as PopulatedTransaction;
      await assertPromiseError(submitTransaction(tronWeb, populatedTx, FEE_LIMIT), "must transfer a non-zero value");
      expect(transfers).to.deep.equal([]);
    });

    // `transactionBuilder.sendTrx` validates the amount only after a `parseInt()`, so a fractional
    // amount would be truncated and broadcast — 1.9 SUN silently becoming 1. The `trx.sendTransaction`
    // call this path replaced rejected it outright, so the guard has to live here now.
    it("Rejects a fractional transfer amount rather than truncating it", async function () {
      const { tronWeb, transfers } = fakeTronWeb();

      const populatedTx = { to: RECIPIENT } as PopulatedTransaction;
      await assertPromiseError(submitTransaction(tronWeb, populatedTx, FEE_LIMIT, 1.9), "whole number of SUN");
      expect(transfers).to.deep.equal([]);
    });

    it("Rejects a transaction with no recipient", async function () {
      const { tronWeb } = fakeTronWeb();

      const populatedTx = { data: CALLDATA } as PopulatedTransaction;
      await assertPromiseError(submitTransaction(tronWeb, populatedTx, FEE_LIMIT), "must have a 'to' field");
    });

    it("Reports a failed transfer broadcast", async function () {
      const { tronWeb } = fakeTronWeb({ result: false });

      const populatedTx = { to: RECIPIENT } as PopulatedTransaction;
      const result = await submitTransaction(tronWeb, populatedTx, FEE_LIMIT, 1);

      // The local txID is the fallback when the node rejects the broadcast and returns no txid.
      expect(result).to.deep.equal({ txid: TXID, result: false });
    });

    it("Reports the node's code and decoded message on a rejected broadcast", async function () {
      const { tronWeb } = fakeTronWeb({
        result: false,
        txid: TXID,
        code: "TAPOS_ERROR",
        message: hexEncode("Tapos check error"),
      });

      const populatedTx = { to: RECIPIENT, data: CALLDATA } as PopulatedTransaction;
      const result = await submitTransaction(tronWeb, populatedTx, FEE_LIMIT, 0);

      expect(result).to.deep.equal({
        txid: TXID,
        result: false,
        code: "TAPOS_ERROR",
        message: "Tapos check error",
      });
    });

    // DUP_TRANSACTION_ERROR is TRON's "already known": the node is holding this exact transaction,
    // so the send succeeded. Reporting it as a failure would invite a resubmission, and - TRON
    // having no nonce to replace through - that would be a second, independent transaction.
    it("Treats a duplicate-transaction rejection as a successful send", async function () {
      const { tronWeb } = fakeTronWeb({ result: false, txid: TXID, code: "DUP_TRANSACTION_ERROR" });

      const populatedTx = { to: RECIPIENT, data: CALLDATA } as PopulatedTransaction;
      const result = await submitTransaction(tronWeb, populatedTx, FEE_LIMIT, 0);

      expect(result).to.deep.equal({ txid: TXID, result: true });
    });

    // TronWeb's typings declare `code` as the protocol's numeric enum, in which
    // DUP_TRANSACTION_ERROR is 5. Missing that form would report the node's own copy of the
    // transaction as a failed send — precisely the resubmission this change exists to prevent.
    it("Treats a numeric duplicate response code as a successful send", async function () {
      const { tronWeb } = fakeTronWeb({ result: false, txid: TXID, code: 5 });

      const populatedTx = { to: RECIPIENT, data: CALLDATA } as PopulatedTransaction;
      const result = await submitTransaction(tronWeb, populatedTx, FEE_LIMIT, 0);

      expect(result).to.deep.equal({ txid: TXID, result: true });
    });

    // A caller comparing against `code` should not have to handle both forms.
    it("Resolves a numeric response code to its name", async function () {
      const { tronWeb } = fakeTronWeb({ result: false, txid: TXID, code: 6, message: hexEncode("Tapos check error") });

      const populatedTx = { to: RECIPIENT, data: CALLDATA } as PopulatedTransaction;
      const result = await submitTransaction(tronWeb, populatedTx, FEE_LIMIT, 0);

      expect(result).to.deep.equal({ txid: TXID, result: false, code: "TAPOS_ERROR", message: "Tapos check error" });
    });

    // An unrecognised code is surfaced rather than dropped: the node said something, and a caller
    // debugging a rejection needs to see it.
    it("Preserves an unrecognised response code", async function () {
      const { tronWeb } = fakeTronWeb({ result: false, txid: TXID, code: 99 });

      const populatedTx = { to: RECIPIENT, data: CALLDATA } as PopulatedTransaction;
      const result = await submitTransaction(tronWeb, populatedTx, FEE_LIMIT, 0);

      expect(result).to.deep.equal({ txid: TXID, result: false, code: "99" });
    });

    it("Treats a duplicate-transaction rejection on a transfer as a successful send", async function () {
      const { tronWeb } = fakeTronWeb({ result: false, txid: TXID, code: "DUP_TRANSACTION_ERROR" });

      const result = await submitTransaction(tronWeb, { to: RECIPIENT } as PopulatedTransaction, FEE_LIMIT, 1);

      expect(result).to.deep.equal({ txid: TXID, result: true });
    });

    // The transaction is signed before it is broadcast, so a throw from the send leaves a fully
    // formed transaction that may or may not have reached the network. Dropping its txid would
    // strand it: the caller could neither confirm it nor safely replace it.
    it("Carries the txid on a contract call whose broadcast throws", async function () {
      const cause = new Error("socket hang up");
      const { tronWeb, signed } = fakeTronWeb(cause);

      const populatedTx = { to: RECIPIENT, data: CALLDATA } as PopulatedTransaction;
      const error = await submitTransaction(tronWeb, populatedTx, FEE_LIMIT, 0).catch((error: unknown) => error);

      expect(signed).to.deep.equal([TXID]);
      expect(isTronBroadcastError(error)).to.be.true;
      expect((error as TronBroadcastError).txid).to.equal(TXID);
      expect((error as TronBroadcastError).cause).to.equal(cause);
      expect((error as TronBroadcastError).message)
        .to.contain(TXID)
        .and.to.contain("socket hang up");
    });

    it("Carries the txid on a transfer whose broadcast throws", async function () {
      const { tronWeb, transfers } = fakeTronWeb(new Error("socket hang up"));

      const error = await submitTransaction(tronWeb, { to: RECIPIENT } as PopulatedTransaction, FEE_LIMIT, 1).catch(
        (error: unknown) => error
      );

      expect(transfers.length).to.equal(1);
      expect(isTronBroadcastError(error)).to.be.true;
      expect((error as TronBroadcastError).txid).to.equal(TXID);
    });

    // The SDK ships CJS and ESM builds, so a consumer loading both cannot rely on class identity.
    it("Recognises a structurally-equivalent broadcast error", function () {
      const impostor = Object.assign(new Error("from another module instance"), {
        name: "TronBroadcastError",
        txid: TXID,
      });

      expect(isTronBroadcastError(impostor)).to.be.true;
      expect(isTronBroadcastError(new Error("unrelated"))).to.be.false;
      expect(isTronBroadcastError(undefined)).to.be.false;
    });
  });
});
