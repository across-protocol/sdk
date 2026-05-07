import { SVMProvider } from "../../arch/svm";
import { BN, toBN, dedupArray } from "../../utils";
import { SvmGasPriceEstimate } from "../types";
import { GasPriceEstimateOptions } from "../oracle";
import { SvmGasPriceUnavailableError } from "../errors";
import {
  TransactionMessage,
  TransactionMessageBytesBase64,
  TransactionMessageWithFeePayer,
  compileTransaction,
  setTransactionMessageLifetimeUsingBlockhash,
} from "@solana/kit";

const MAX_BASE_FEE_ATTEMPTS = 2;

/**
 * @notice Returns result of getFeeForMessage and getRecentPrioritizationFees RPC calls.
 * @returns GasPriceEstimate
 */
export async function messageFee(provider: SVMProvider, opts: GasPriceEstimateOptions): Promise<SvmGasPriceEstimate> {
  const { unsignedTx: _unsignedTx } = opts;

  // Cast the opaque unsignedTx type to a solana-kit TransactionMessage with fee payer.
  const unsignedTx = _unsignedTx as TransactionMessage & TransactionMessageWithFeePayer;

  const baseFee = await getBaseFee(provider, unsignedTx);

  // Get the priority fee by calling `getRecentPrioritzationFees` on all the addresses in the transaction's instruction array.
  const instructionAddresses = dedupArray(unsignedTx.instructions.map((instruction) => instruction.programAddress));
  const recentPriorityFees = await provider.getRecentPrioritizationFees(instructionAddresses).send();

  // Take the most recent 25 slots and find the average of the nonzero priority fees.
  const nonzeroPrioritizationFees = recentPriorityFees
    .slice(125)
    .map((value) => value.prioritizationFee)
    .filter((fee) => fee > 0);
  const totalPrioritizationFees = nonzeroPrioritizationFees.reduce((acc, fee) => acc + fee, BigInt(0));

  const microLamportsPerComputeUnit = toBN(
    totalPrioritizationFees / BigInt(Math.max(nonzeroPrioritizationFees.length, 1))
  );

  return { baseFee, microLamportsPerComputeUnit };
}

// `getFeeForMessage` returns `{ value: null }` when the cluster has not yet recognised
// the blockhash referenced by the message. With a load-balanced RPC pool, this happens
// when the request lands on a node that hasn't seen the blockhash from an earlier
// `getLatestBlockhash` call. We side-step the race by always refreshing to a `confirmed`
// blockhash before each attempt — by definition propagated to all healthy nodes — and
// retrying once if a fee call still comes back null. Fee estimation is never sent
// on-chain, so blockhash freshness doesn't matter.
async function getBaseFee(provider: SVMProvider, tx: TransactionMessage & TransactionMessageWithFeePayer): Promise<BN> {
  for (let attempt = 0; attempt < MAX_BASE_FEE_ATTEMPTS; attempt++) {
    const { value: confirmedBlockhash } = await provider.getLatestBlockhash({ commitment: "confirmed" }).send();
    const refreshedTx = setTransactionMessageLifetimeUsingBlockhash(confirmedBlockhash, tx);
    const compiled = compileTransaction(refreshedTx);
    const encoded = Buffer.from(compiled.messageBytes).toString("base64") as TransactionMessageBytesBase64;
    const { value } = await provider.getFeeForMessage(encoded).send();
    if (value !== null && value !== undefined) {
      return toBN(value);
    }
  }
  throw new SvmGasPriceUnavailableError(
    "Solana getFeeForMessage returned null even after retrying with a confirmed blockhash"
  );
}
