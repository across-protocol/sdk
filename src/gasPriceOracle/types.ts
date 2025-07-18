import { type Chain, type Transport, PublicClient, FeeValuesEIP1559 } from "viem";
import { BigNumber, isDefined } from "../utils";

export type InternalGasPriceEstimate = FeeValuesEIP1559;
export type GasPriceEstimate = EvmGasPriceEstimate | SvmGasPriceEstimate;

export type EvmGasPriceEstimate = {
  maxFeePerGas: BigNumber;
  maxPriorityFeePerGas: BigNumber;
};

export type SvmGasPriceEstimate = {
  baseFee: BigNumber;
  microLamportsPerComputeUnit: BigNumber;
};

export interface GasPriceFeed {
  (provider: PublicClient<Transport, Chain>, chainId: number): Promise<InternalGasPriceEstimate>;
}

export function isEVMGasPrice(gasPrice: GasPriceEstimate): gasPrice is EvmGasPriceEstimate {
  const { maxFeePerGas, maxPriorityFeePerGas } = gasPrice as EvmGasPriceEstimate;
  return isDefined(maxFeePerGas) && isDefined(maxPriorityFeePerGas);
}

export function isSVMGasPrice(gasPrice: GasPriceEstimate): gasPrice is SvmGasPriceEstimate {
  const { baseFee, microLamportsPerComputeUnit } = gasPrice as SvmGasPriceEstimate;
  return isDefined(baseFee) && isDefined(microLamportsPerComputeUnit);
}
