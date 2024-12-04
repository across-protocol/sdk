import { PublicClient } from "viem";
import { estimateGas } from "viem/linea";
import { DEFAULT_SIMULATED_RELAYER_ADDRESS as account } from "../../constants";
import { InternalGasPriceEstimate } from "../types";

export async function eip1559(provider: PublicClient, _chainId?: number): Promise<InternalGasPriceEstimate> {
  const { baseFeePerGas, priorityFeePerGas } = await estimateGas(provider, {
    account,
    to: account,
    value: BigInt(1),
  });

  return {
    maxFeePerGas: baseFeePerGas + priorityFeePerGas,
    maxPriorityFeePerGas: priorityFeePerGas,
  };
}
