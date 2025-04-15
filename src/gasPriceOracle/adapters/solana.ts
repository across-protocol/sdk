import { providers } from "ethers";
import { bnZero, toBN, isDefined } from "../../utils";
import { GasPriceEstimate } from "../types";
import { GasPriceEstimateOptions } from "../oracle";

const LAMPORTS_PER_SIGNATURE = 5000;

/**
 * @notice Returns result of eth_gasPrice RPC call
 * @dev Its recommended to use the eip1559Raw method over this one where possible as it will be more accurate.
 * @returns GasPriceEstimate
 */
export function algorithmic(_provider: providers.Provider, opts: GasPriceEstimateOptions): GasPriceEstimate {
  const { solTransaction } = opts;

  if (isDefined(solTransaction)) {
    const gasPrice = LAMPORTS_PER_SIGNATURE * Object.keys(solTransaction.signatures).length;
    return {
      maxFeePerGas: toBN(gasPrice), // Scaling the max fee per gas is meaningless on Solana.
      maxPriorityFeePerGas: bnZero, // TODO.
    };
  }
  // TODO
  return {
    maxFeePerGas: toBN(LAMPORTS_PER_SIGNATURE),
    maxPriorityFeePerGas: bnZero,
  };
}
