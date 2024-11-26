import { PublicClient } from "viem";
import { estimateGas } from "viem/linea";
import { InternalGasPriceEstimate } from "../types";

export async function eip1559(provider: PublicClient, _chainId?: number): Promise<InternalGasPriceEstimate> {
  const account = "0x07ae8551be970cb1cca11dd7a11f47ae82e70e67";

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
