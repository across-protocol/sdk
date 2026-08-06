import { PopulatedTransaction } from "ethers";
import { TronWeb } from "tronweb";
import { submitTransaction } from "../src/arch/tvm";
import { assertPromiseError, expect } from "./utils";

// EVM-format addresses and their Base58 equivalents. TRON encodes an address as the 20-byte EVM
// address prefixed with 0x41, base58check-encoded.
const RECIPIENT = "0xf7bAc63fc7CEaCf0589F25454Ecf5C2ce904997c";
const RECIPIENT_BASE58 = "TYZ5ekizCPH4QdsnMfqQUFXBLtsuTuUKjJ";
const OWNER_BASE58 = "TQ42TumxqaP1gHs216UA9u36soVdza4T5Y";

const TXID = "3b699036b64d765dea6a9103c33793d343381bab361b3e96051e56de2d174247";
const FEE_LIMIT = 100_000_000;
const CALLDATA = "0xdeadbeef";

type Transfer = { to: string; amount: number };
type ContractCall = { to: string; selector: string; options: Record<string, unknown>; owner: string };

type FakeTronWeb = {
  tronWeb: TronWeb;
  transfers: Transfer[];
  contractCalls: ContractCall[];
};

/**
 * A TronWeb instance that records what was submitted instead of broadcasting it. `broadcast` is the
 * response returned by both submission paths, permitting a failed or txid-less broadcast.
 */
function fakeTronWeb(broadcast: { result?: boolean; txid?: string } = { result: true, txid: TXID }): FakeTronWeb {
  const transfers: Transfer[] = [];
  const contractCalls: ContractCall[] = [];

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
    },
    trx: {
      sendTransaction: (to: string, amount: number) => {
        transfers.push({ to, amount });
        return Promise.resolve({ ...broadcast, transaction: { txID: TXID } });
      },
      sign: (txn: unknown) => Promise.resolve(txn),
      sendRawTransaction: () => Promise.resolve({ ...broadcast, transaction: { txID: TXID } }),
    },
  } as unknown as TronWeb;

  return { tronWeb, transfers, contractCalls };
}

describe("TVM TransactionUtils", function () {
  describe("submitTransaction", function () {
    it("Transfers TRX when the transaction has no calldata", async function () {
      const { tronWeb, transfers, contractCalls } = fakeTronWeb();
      const callValue = 1_500_000; // 1.5 TRX in SUN.

      const result = await submitTransaction(tronWeb, { to: RECIPIENT } as PopulatedTransaction, FEE_LIMIT, callValue);

      // A transfer is a TransferContract, not a TriggerSmartContract, and pays bandwidth rather
      // than energy - so no fee limit is involved.
      expect(transfers).to.deep.equal([{ to: RECIPIENT_BASE58, amount: callValue }]);
      expect(contractCalls).to.deep.equal([]);
      expect(result).to.deep.equal({ txid: TXID, result: true });
    });

    it("Treats empty calldata as a transfer", async function () {
      const { tronWeb, transfers, contractCalls } = fakeTronWeb();

      const populatedTx = { to: RECIPIENT, data: "0x" } as PopulatedTransaction;
      await submitTransaction(tronWeb, populatedTx, FEE_LIMIT, 1);

      expect(transfers).to.deep.equal([{ to: RECIPIENT_BASE58, amount: 1 }]);
      expect(contractCalls).to.deep.equal([]);
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
  });
});
