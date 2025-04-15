import { Provider } from "../../arch/svm";
import { bnZero, toBN } from "../../utils";
import { GasPriceEstimate } from "../types";
import { GasPriceEstimateOptions } from "../oracle";
import { Transaction } from "@solana/kit";

const LAMPORTS_PER_SIGNATURE = 5000;

/**
 * @notice Returns result of getFeeForMessage and getRecentPrioritizationFees RPC calls.
 * @returns GasPriceEstimate
 */
export function messageFee(provider: Provider, opts: GasPriceEstimateOptions): GasPriceEstimate {
  const { unsignedTx: _unsignedTx } = opts;
  const unsignedTx = _unsignedTx as Transaction; // Cast the opaque unsignedTx type to a solana-kit Transaction.

  const gasPrice = LAMPORTS_PER_SIGNATURE * Object.keys(unsignedTx.signatures).length;
  return {
    maxFeePerGas: toBN(gasPrice), // Scaling the max fee per gas is meaningless on Solana.
    maxPriorityFeePerGas: bnZero, // TODO.
  };
  // TODO
  provider;
  return {
    maxFeePerGas: toBN(LAMPORTS_PER_SIGNATURE),
    maxPriorityFeePerGas: bnZero,
  };
}
