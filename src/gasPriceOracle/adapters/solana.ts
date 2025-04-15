import { Provider } from "../../arch/svm";
import { toBN } from "../../utils";
import { GasPriceEstimate } from "../types";
import { GasPriceEstimateOptions } from "../oracle";
import { Transaction, TransactionMessageBytesBase64 } from "@solana/kit";

/**
 * @notice Returns result of getFeeForMessage and getRecentPrioritizationFees RPC calls.
 * @returns GasPriceEstimate
 */
export async function messageFee(provider: Provider, opts: GasPriceEstimateOptions): Promise<GasPriceEstimate> {
  const { unsignedTx: _unsignedTx } = opts;
  const unsignedTx = _unsignedTx as Transaction; // Cast the opaque unsignedTx type to a solana-kit Transaction.

  // Get this base fee. This should result in LAMPORTS_PER_SIGNATURE * nSignatures.
  const encodedTransactionMessage = Buffer.from(unsignedTx.messageBytes).toString(
    "base64"
  ) as TransactionMessageBytesBase64;
  const baseFeeResponse = await provider.getFeeForMessage(encodedTransactionMessage).send();

  // Get the priority fee.
  const recentPriorityFees = await provider.getRecentPrioritizationFees().send();

  // TODO: Do some transformation on this value.
  const priorityFeesPerComputeUnit =
    (recentPriorityFees.reduce((acc, fee) => acc + Number(fee.prioritizationFee), 0) *
      opts.priorityFeeMultiplier.toNumber()) /
    recentPriorityFees.length;
  return {
    maxFeePerGas: toBN(baseFeeResponse!.value!),
    maxPriorityFeePerGas: toBN(priorityFeesPerComputeUnit),
  };
}
