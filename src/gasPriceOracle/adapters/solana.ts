import { Provider } from "../../arch/svm";
import { toBN, dedupArray } from "../../utils";
import { GasPriceEstimate } from "../types";
import { GasPriceEstimateOptions } from "../oracle";
import { CompilableTransactionMessage, TransactionMessageBytesBase64, compileTransaction } from "@solana/kit";

/**
 * @notice Returns result of getFeeForMessage and getRecentPrioritizationFees RPC calls.
 * @returns GasPriceEstimate
 */
export async function messageFee(provider: Provider, opts: GasPriceEstimateOptions): Promise<GasPriceEstimate> {
  const { unsignedTx: _unsignedTx } = opts;

  // Cast the opaque unsignedTx type to a solana-kit CompilableTransactionMessage.
  const unsignedTx = _unsignedTx as CompilableTransactionMessage;
  const compiledTransaction = compileTransaction(unsignedTx);

  // Get this base fee. This should result in LAMPORTS_PER_SIGNATURE * nSignatures.
  const encodedTransactionMessage = Buffer.from(compiledTransaction.messageBytes).toString(
    "base64"
  ) as TransactionMessageBytesBase64;
  const baseFeeResponse = await provider.getFeeForMessage(encodedTransactionMessage).send();

  // Get the priority fee by calling `getRecentPrioritzationFees` on all the addresses in the transaction's instruction array.
  const instructionAddresses = dedupArray(unsignedTx.instructions.map((instruction) => instruction.programAddress));
  const recentPriorityFees = await provider.getRecentPrioritizationFees(instructionAddresses).send();

  const nonzeroPrioritizationFees = recentPriorityFees.map((value) => value.prioritizationFee).filter((fee) => fee > 0);
  const totalPrioritizationFees = nonzeroPrioritizationFees.reduce((acc, fee) => acc + fee, BigInt(0));
  return {
    baseFee: toBN(baseFeeResponse!.value!),
    microLamportsPerComputeUnit: toBN(totalPrioritizationFees / BigInt(nonzeroPrioritizationFees.length)),
  };
}
