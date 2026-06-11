import { arch } from "../..";
import { RelayData } from "../../interfaces";
import { BigNumber } from "../../utils";
import { CustomGasTokenQueries } from "./customGasToken";

/**
 * TVM (TRON) query implementation. Extends `CustomGasTokenQueries` to add bandwidth
 * accounting via `getAuxiliaryNativeTokenCost`, which the base EVM path returns 0 for.
 *
 * Energy (Tron's analogue of gas) is already estimated by `voidSigner.estimateGas`
 * against the EVM-compat RPC and surfaces in `tokenGasCost`. Bandwidth is a separate
 * Tron-native resource that the EVM compatibility layer does not surface, so we
 * estimate it here from the deposit's `message` length and a fixed `fillRelay`
 * calldata footprint.
 */
export class TvmQuery extends CustomGasTokenQueries {
  override getAuxiliaryNativeTokenCost(deposit: RelayData): BigNumber {
    return arch.tvm.getAuxiliaryNativeTokenCost(deposit);
  }
}
