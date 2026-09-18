import { arch } from "../..";
import { getV3RelayCalldata } from "../../arch/evm";
import { RelayData } from "../../interfaces";
import { BigNumber } from "../../utils";
import { CustomGasTokenQueries } from "./customGasToken";
import { getDefaultRelayer } from "../relayFeeCalculator";

/**
 * TVM (TRON) query implementation. Extends `CustomGasTokenQueries` to add bandwidth
 * accounting via `getAuxiliaryNativeTokenCost`, which the base EVM path returns 0 for.
 *
 * Energy (Tron's analogue of gas) is already estimated by `voidSigner.estimateGas`
 * against the EVM-compat RPC and surfaces in `tokenGasCost`. Bandwidth is a separate
 * Tron-native resource that the EVM compatibility layer does not surface, so we measure
 * it here from the real ABI-encoded fillRelay/fillRelayWithUpdatedDeposit calldata
 * (`getV3RelayCalldata`, a synchronous calldata-only counterpart to `populateV3Relay`),
 * rather than modeling a per-function calldata size that could drift from the actual ABI.
 * The repayment address's value never affects calldata length (it's a fixed-size bytes32
 * regardless of content), so a default placeholder is fine here.
 */
export class TvmQuery extends CustomGasTokenQueries {
  override getAuxiliaryNativeTokenCost(deposit: RelayData & { destinationChainId: number }): BigNumber {
    const calldata = getV3RelayCalldata(this.spokePool, deposit, getDefaultRelayer(deposit.destinationChainId));
    return arch.tvm.getAuxiliaryNativeTokenCost(calldata);
  }
}
