import { RelayData } from "../../interfaces";
import { BigNumber, bnZero } from "../../utils";

/**
 * @notice Return the native token cost of filling a deposit beyond gas cost. We're not using msg.value in our fills,
 * so return zero for EVM side
 * @param deposit RelayData associated with Deposit we're estimating for
 * @returns Native token cost
 */
export function getAuxiliaryNativeTokenCost(_deposit: RelayData): BigNumber {
  return bnZero;
}
