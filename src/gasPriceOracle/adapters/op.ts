import assert from "assert";
import { BigNumber, providers } from "ethers";
import { chainIsOPStack } from "../../utils";
import { GasPriceEstimate } from "../types";

// 50 Wei should be sufficient to land a transaction on the OP stack.
// Double it just to be on the safe side. The user is encouraged to scale it further as needed.
const MAX_PRIORITY_FEE_PER_GAS = BigNumber.from("100");

export async function legacy(provider: providers.Provider, chainId: number): Promise<GasPriceEstimate> {
  assert(chainIsOPStack(chainId), `Unsupported OP chain ID: ${chainId}`);
  const gasPrice = await provider.getGasPrice(); // Get the base L2 fee.
  return {
    maxFeePerGas: gasPrice.add(MAX_PRIORITY_FEE_PER_GAS),
    maxPriorityFeePerGas: MAX_PRIORITY_FEE_PER_GAS, // The common minimum for landing an OP stack transaction.
  };
}
