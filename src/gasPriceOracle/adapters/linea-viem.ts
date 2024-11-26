import { PublicClient } from "viem";
import { InternalGasPriceEstimate } from "../types";
import { createPublicClient } from 'viem'
import { linea } from 'viem/chains'
import { estimateGas } from 'viem/linea'

export async function eip1559(provider: PublicClient, _chainId: number): Promise<InternalGasPriceEstimate> {
  const account = "0x...";

	const lineaClient = createPublicClient({ chain: linea, transport: provider.transport });

  // @todo: Coax viem into recognising that this is a Linea-specific provider.
  // https://github.com/wevm/viem/blob/main/src/linea/actions/estimateGas.ts
  const { baseFeePerGas, priorityFeePerGas } = await estimateGas(lineaClient, {
    account,
    to: account,
    value: BigInt(1),
  });

  return {
    maxFeePerGas: baseFeePerGas + priorityFeePerGas,
    maxPriorityFeePerGas: priorityFeePerGas,
  };
}
