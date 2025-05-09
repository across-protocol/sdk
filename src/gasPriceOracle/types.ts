import { type Chain, type Transport, PublicClient, FeeValuesEIP1559 } from "viem";
import { BigNumber } from "../utils";

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
