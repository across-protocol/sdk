import { arch } from "../..";
import { getV3RelayCalldata } from "../../arch/evm";
import { RelayData, SpeedUpCommon } from "../../interfaces";
import { BigNumber, isMessageEmpty } from "../../utils";
import { CustomGasTokenQueries } from "./customGasToken";
import { getDefaultRelayer } from "../relayFeeCalculator";

/**
 * TVM (TRON) query implementation. Adds bandwidth accounting via
 * `getAuxiliaryNativeTokenCost`, which the base EVM path returns 0 for: Tron bandwidth
 * bills separately from energy (`tokenGasCost`), so we measure it from the real
 * fillRelay/fillRelayWithUpdatedDeposit calldata rather than modeling it. The repayment
 * address's value never affects calldata length, so a default placeholder is fine here.
 */
export class TvmQuery extends CustomGasTokenQueries {
  override getAuxiliaryNativeTokenCost(
    deposit: RelayData & Partial<SpeedUpCommon> & { destinationChainId: number; speedUpSignature?: string }
  ): BigNumber {
    // The real ABI encoder rejects two inputs this codebase otherwise treats as no-ops:
    // message "" instead of "0x" (isMessageEmpty), and a present-but-empty speedUpSignature.
    const message = isMessageEmpty(deposit.message) ? "0x" : deposit.message;
    const speedUpSignature = !isMessageEmpty(deposit.speedUpSignature) ? deposit.speedUpSignature : undefined;

    const calldata = getV3RelayCalldata(
      this.spokePool,
      { ...deposit, message, speedUpSignature },
      getDefaultRelayer(deposit.destinationChainId)
    );
    return arch.tvm.bandwidthCostForCalldata(calldata);
  }
}
