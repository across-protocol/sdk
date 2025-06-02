import { PopulatedTransaction } from "ethers";
import { Address, Hex, PublicClient } from "viem";
import { estimateGas } from "viem/linea";
import { DEFAULT_SIMULATED_RELAYER_ADDRESS as account } from "../../constants";
import { InternalGasPriceEstimate } from "../types";
import { GasPriceEstimateOptions } from "../oracle";
import { fixedPointAdjustment } from "../../utils";

/**
 * @notice The Linea viem provider calls the linea_estimateGas RPC endpoint to estimate gas. Linea is unique
 * in that the recommended fee per gas is hardcoded to 7 wei while the priority fee is dynamic based on the
 * compressed transaction size, layer 1 verification costs and capacity, gas price ratio between layer 1 and layer 2,
 * the transaction's gas usage, the minimum gas price on layer 2,
 * and a minimum margin (for error) for gas price estimation.
 * Source: https://docs.linea.build/get-started/how-to/gas-fees#how-gas-works-on-linea
 * @dev Because the Linea priority fee is more volatile than the base fee, the base fee multiplier will be applied
 * to the priority fee.
 * @param provider Viem PublicClient
 * @param opts Relevant options for Linea are baseFeeMultiplier and unsignedTx.
 * @param baseFeeMultiplier Unused since Linea's base fee is hardcoded while its priority fee is dynamic.
 * @param priorityFeeMultiplier Amount to multiply priority fee.
 * @param unsignedTx Should contain any params passed to linea_estimateGas, which are listed
 * here: https://docs.linea.build/api/reference/linea-estimategas#parameters
 * @returns
 */
export async function eip1559(
  provider: PublicClient,
  opts: GasPriceEstimateOptions
): Promise<InternalGasPriceEstimate> {
  const { unsignedTx: _unsignedTx, priorityFeeMultiplier } = opts;
  const unsignedTx = _unsignedTx as PopulatedTransaction; // Cast the opaque unsignedTx type to an ethers PopulatedTransaction.
  const { baseFeePerGas, priorityFeePerGas: _priorityFeePerGas } = await estimateGas(provider, {
    account: (unsignedTx?.from as Address) ?? account,
    to: (unsignedTx?.to as Address) ?? account,
    value: BigInt(unsignedTx?.value?.toString() ?? "0"),
    data: (unsignedTx?.data as Hex) ?? "0x",
  });
  const priorityFeePerGas =
    (_priorityFeePerGas * BigInt(priorityFeeMultiplier.toString())) / BigInt(fixedPointAdjustment.toString());

  return {
    maxFeePerGas: baseFeePerGas + priorityFeePerGas,
    maxPriorityFeePerGas: priorityFeePerGas,
  };
}
