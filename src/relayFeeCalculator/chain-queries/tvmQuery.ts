import { arch } from "../..";
import { RelayData } from "../../interfaces";
import { BigNumber } from "../../utils";
import { assertEvmOrTvmRelayData } from "./baseQuery";
import { CustomGasTokenQueries } from "./customGasToken";

/**
 * TVM (TRON) query implementation. Extends `CustomGasTokenQueries` to add bandwidth
 * accounting via `getAuxiliaryNativeTokenCost`, which the base EVM path returns 0 for.
 *
 * Energy (Tron's analogue of gas) is already estimated by `voidSigner.estimateGas`
 * against the EVM-compat RPC and surfaces in `tokenGasCost`. Bandwidth is a separate
 * Tron-native resource that the EVM compatibility layer does not surface, so we
 * measure it here directly from the real populated transaction's calldata, rather than
 * modeling a per-function calldata size that could drift from the actual ABI.
 */
export class TvmQuery extends CustomGasTokenQueries {
  override async getAuxiliaryNativeTokenCost(deposit: RelayData & { destinationChainId: number }): Promise<BigNumber> {
    assertEvmOrTvmRelayData(deposit);
    const { data } = await this.getUnsignedTxFromDeposit(deposit);
    return arch.tvm.getAuxiliaryNativeTokenCost(data ?? "0x");
  }
}
