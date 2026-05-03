import {
  pipe,
  createTransactionMessage,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  TransactionMessage,
  TransactionMessageWithFeePayer,
  type Blockhash,
} from "@solana/kit";

import { messageFee } from "../src/gasPriceOracle/adapters/solana";
import { SvmGasPriceUnavailableError } from "../src/gasPriceOracle/errors";
import { SolanaVoidSigner } from "../src/arch/svm/utils";
import { SVMProvider } from "../src/arch/svm/types";
import { GasPriceEstimateOptions } from "../src/gasPriceOracle/oracle";
import { expect, sinon } from "./utils";

// Sentinel SVM addresses — only their on-curve / format validity matters for the
// kit's tx construction; nothing in the test actually executes against Solana.
const FEE_PAYER = "GsiZqCTNRi4T3qZrixFdmhXVeA4CSUzS7c44EQ7Rw1Tw";
const STALE_BLOCKHASH = "GHtXQBsoZHVnNFa9YevAzFTd5Z7VqhfM2HzDjP9wPMpL";
const FRESH_BLOCKHASH = "9YL6XayQVcnWzkFZW4hGCH4tEZRG6e7nZ6FdBxV4PXVH";

function buildEmptyTx(blockhash: string): TransactionMessage & TransactionMessageWithFeePayer {
  const signer = SolanaVoidSigner(FEE_PAYER);
  return pipe(
    createTransactionMessage({ version: 0 }),
    (tx) => setTransactionMessageFeePayerSigner(signer, tx),
    (tx) =>
      setTransactionMessageLifetimeUsingBlockhash({ blockhash: blockhash as Blockhash, lastValidBlockHeight: 0n }, tx)
  ) as TransactionMessage & TransactionMessageWithFeePayer;
}

// Build a minimal RPC-call shim: each provider method returns an object with
// `.send()` so the call-site `provider.foo(...).send()` resolves to whatever the
// stub is configured to return.
type Send<T> = { send: () => Promise<T> };
function rpcCall<T>(returnValue: T): Send<T> {
  return { send: () => Promise.resolve(returnValue) };
}

describe("gasPriceOracle/adapters/solana#messageFee", () => {
  let getFeeForMessage: sinon.SinonStub;
  let getRecentPrioritizationFees: sinon.SinonStub;
  let getLatestBlockhash: sinon.SinonStub;
  let provider: SVMProvider;
  let opts: GasPriceEstimateOptions;

  beforeEach(() => {
    getFeeForMessage = sinon.stub();
    getRecentPrioritizationFees = sinon.stub().returns(rpcCall([]));
    getLatestBlockhash = sinon.stub();

    provider = {
      getFeeForMessage,
      getRecentPrioritizationFees,
      getLatestBlockhash,
    } as unknown as SVMProvider;

    opts = {
      chainId: 34268394551451,
      unsignedTx: buildEmptyTx(STALE_BLOCKHASH),
    } as unknown as GasPriceEstimateOptions;
  });

  it("returns the base fee on the happy path (no retry)", async () => {
    getFeeForMessage.returns(rpcCall({ value: 5000n }));

    const result = await messageFee(provider, opts);

    expect(result.baseFee.toString()).to.equal("5000");
    expect(getFeeForMessage.callCount).to.equal(1);
    expect(getLatestBlockhash.callCount).to.equal(0);
  });

  it("retries once with a confirmed blockhash when the first call returns null", async () => {
    getFeeForMessage.onFirstCall().returns(rpcCall({ value: null }));
    getFeeForMessage.onSecondCall().returns(rpcCall({ value: 5000n }));
    getLatestBlockhash.returns(
      rpcCall({ value: { blockhash: FRESH_BLOCKHASH as Blockhash, lastValidBlockHeight: 0n } })
    );

    const result = await messageFee(provider, opts);

    expect(result.baseFee.toString()).to.equal("5000");
    expect(getFeeForMessage.callCount).to.equal(2);
    expect(getLatestBlockhash.callCount).to.equal(1);
    // Crucial: refresh must use commitment:"confirmed" — the whole point of the retry.
    expect(getLatestBlockhash.firstCall.args[0]).to.deep.equal({ commitment: "confirmed" });
  });

  it("throws SvmGasPriceUnavailableError when the retry also returns null", async () => {
    getFeeForMessage.returns(rpcCall({ value: null }));
    getLatestBlockhash.returns(
      rpcCall({ value: { blockhash: FRESH_BLOCKHASH as Blockhash, lastValidBlockHeight: 0n } })
    );

    let caught: unknown;
    try {
      await messageFee(provider, opts);
    } catch (e) {
      caught = e;
    }
    expect(caught).to.be.instanceOf(SvmGasPriceUnavailableError);
    expect(caught).to.be.instanceOf(Error);
    expect(getFeeForMessage.callCount).to.equal(2);
  });

  it("doesn't retry on the residual third call — exactly one retry", async () => {
    getFeeForMessage.returns(rpcCall({ value: null }));
    getLatestBlockhash.returns(
      rpcCall({ value: { blockhash: FRESH_BLOCKHASH as Blockhash, lastValidBlockHeight: 0n } })
    );

    await messageFee(provider, opts).catch(() => undefined);
    expect(getFeeForMessage.callCount).to.equal(2);
    expect(getLatestBlockhash.callCount).to.equal(1);
  });

  it("computes microLamportsPerComputeUnit as the average of nonzero recent priority fees", async () => {
    getFeeForMessage.returns(rpcCall({ value: 5000n }));
    // Slot 125 is the cutoff — only fees AT OR AFTER that index are considered.
    const fees = Array.from({ length: 130 }, (_, i) => ({
      slot: BigInt(i),
      prioritizationFee: i >= 125 ? 100n : 0n,
    }));
    getRecentPrioritizationFees.returns(rpcCall(fees));

    const result = await messageFee(provider, opts);

    expect(result.microLamportsPerComputeUnit.toString()).to.equal("100");
  });
});
