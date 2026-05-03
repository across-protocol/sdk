import { SVMProvider } from "../../arch/svm";
import { toBN, dedupArray } from "../../utils";
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

/**
 * @notice Returns result of getFeeForMessage and getRecentPrioritizationFees RPC calls.
 * @returns GasPriceEstimate
 */
export async function messageFee(provider: SVMProvider, opts: GasPriceEstimateOptions): Promise<SvmGasPriceEstimate> {
  const { unsignedTx: _unsignedTx } = opts;

  // Cast the opaque unsignedTx type to a solana-kit TransactionMessage with fee payer.
  const unsignedTx = _unsignedTx as TransactionMessage & TransactionMessageWithFeePayer;

  // Get this base fee. This should result in LAMPORTS_PER_SIGNATURE * nSignatures.
  let baseFeeResponse = await getFeeForCompiledMessage(provider, unsignedTx);

  // `getFeeForMessage` returns `{ value: null }` when the cluster has not yet recognised
  // the blockhash referenced by the message. With a load-balanced RPC pool, this happens
  // when the request lands on a node that hasn't seen the blockhash returned by the
  // earlier `getLatestBlockhash` call. Refresh with a `confirmed` blockhash — by
  // definition propagated to all healthy nodes — and retry once. Fee estimation is never
  // sent on-chain, so there's no downside to using a slightly older blockhash.
  if (baseFeeResponse?.value == null) {
    const { value: confirmedBlockhash } = await provider.getLatestBlockhash({ commitment: "confirmed" }).send();
    const refreshedTx = setTransactionMessageLifetimeUsingBlockhash(confirmedBlockhash, unsignedTx);
    baseFeeResponse = await getFeeForCompiledMessage(provider, refreshedTx);
  }

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

  // Even after the retry above, `value` can be null (e.g. genuinely malformed message,
  // RPC outage). Throw a typed error so callers can map this to a transient upstream
  // failure (5xx) rather than crashing on `toBN(null)`.
  if (baseFeeResponse?.value == null) {
    throw new SvmGasPriceUnavailableError(
      "Solana getFeeForMessage returned null after refreshing the blockhash to a confirmed one"
    );
  }

  return {
    baseFee: toBN(baseFeeResponse.value),
    microLamportsPerComputeUnit,
  };
}

function getFeeForCompiledMessage(
  provider: SVMProvider,
  tx: TransactionMessage & TransactionMessageWithFeePayer
): Promise<Awaited<ReturnType<ReturnType<SVMProvider["getFeeForMessage"]>["send"]>>> {
  const compiled = compileTransaction(tx);
  const encoded = Buffer.from(compiled.messageBytes).toString("base64") as TransactionMessageBytesBase64;
  return provider.getFeeForMessage(encoded).send();
}
