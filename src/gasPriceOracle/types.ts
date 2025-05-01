import { type Chain, type Transport, PublicClient, FeeValuesEIP1559 } from "viem";
import { BigNumber } from "../utils";

export type InternalGasPriceEstimate = FeeValuesEIP1559;
export enum TransactionType {
  LEGACY,
  EIP1559,
}

export type GasPriceEstimate = {
  maxFeePerGas: BigNumber;
  maxPriorityFeePerGas: BigNumber;
  type: TransactionType;
};

export interface GasPriceFeed {
  (provider: PublicClient<Transport, Chain>, chainId: number): Promise<InternalGasPriceEstimate>;
}
