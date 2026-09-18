import { arch } from "../..";
import { getV3RelayCalldata } from "../../arch/evm";
import { RelayData, SpeedUpCommon } from "../../interfaces";
import { BigNumber, isMessageEmpty } from "../../utils";
import { CustomGasTokenQueries } from "./customGasToken";
import { getDefaultRelayer } from "../relayFeeCalculator";

/**
 * TVM (TRON) query. Tron bandwidth bills separately from energy, so `getAuxiliaryNativeTokenCost`
 * (0 on the base EVM path) is measured from the real fill calldata rather than modeled. The
 * repayment address's value never affects calldata length, so a placeholder is fine here.
 */
export class TvmQuery extends CustomGasTokenQueries {
  override getAuxiliaryNativeTokenCost(
    deposit: RelayData & Partial<SpeedUpCommon> & { destinationChainId: number; speedUpSignature?: string }
  ): BigNumber {
    // The real ABI encoder rejects "" where this codebase treats it as a no-op: message,
    // updatedMessage (both via isMessageEmpty), and a present-but-empty speedUpSignature.
    const message = isMessageEmpty(deposit.message) ? "0x" : deposit.message;
    const updatedMessage = isMessageEmpty(deposit.updatedMessage) ? "0x" : deposit.updatedMessage;
    const speedUpSignature = !isMessageEmpty(deposit.speedUpSignature) ? deposit.speedUpSignature : undefined;

    const calldata = getV3RelayCalldata(
      this.spokePool,
      { ...deposit, message, updatedMessage, speedUpSignature },
      getDefaultRelayer(deposit.destinationChainId)
    );
    return arch.tvm.bandwidthCostForCalldata(calldata);
  }
}
