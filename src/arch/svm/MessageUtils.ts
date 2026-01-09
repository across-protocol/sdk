import { deserializeMessage } from ".";
import { RelayData } from "../../interfaces";
import { BigNumber, bnZero, isMessageEmpty } from "../../utils";

/**
 * @notice Return the native token cost of filling a deposit beyond gas cost. We're not using msg.value in our fills,
 * so return zero for EVM side
 * @param deposit RelayData associated with Deposit we're estimating for
 * @returns Native token cost
 */
export function getAuxiliaryNativeTokenCost(deposit: RelayData): BigNumber {
  // Notice. We return `message.value_amount` here instead of simulating the Transaction. The reason is, we choose to
  // rely hard on Solana program to protect us from not taking more than `value_amount` rather than relying on
  // simulation. Chain state may change between simulation and execution, so simulation alone is unreliable
  return isMessageEmpty(deposit.message) ? bnZero : BigNumber.from(deserializeMessage(deposit.message).value_amount);
}
