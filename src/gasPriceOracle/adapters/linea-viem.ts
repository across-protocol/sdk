import { Address, PublicClient } from "viem";
import { estimateGas } from "viem/linea";
import { DEFAULT_SIMULATED_RELAYER_ADDRESS as account } from "../../constants";
import { InternalGasPriceEstimate } from "../types";
import { PopulatedTransaction } from "ethers";

export async function eip1559(
  provider: PublicClient,
  _chainId: number,
  baseFeeMultiplier: number,
  _unsignedTx?: PopulatedTransaction
): Promise<InternalGasPriceEstimate> {
  const { baseFeePerGas, priorityFeePerGas } = await estimateGas(provider, {
    account: (_unsignedTx?.from as Address) ?? account,
    to: (_unsignedTx?.to as Address) ?? account,
    value: BigInt(_unsignedTx?.value?.toString() || "1"),
  });

  return {
    maxFeePerGas: baseFeePerGas * BigInt(baseFeeMultiplier) + priorityFeePerGas,
    maxPriorityFeePerGas: priorityFeePerGas,
  };
}
