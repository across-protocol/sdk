import { BigNumber, providers } from "ethers";

export type GasPriceEstimate = {
  maxFeePerGas: BigNumber;
  maxPriorityFeePerGas: BigNumber;
};

export interface GasPriceFeed {
  (provider: providers.Provider, chainId: number): Promise<GasPriceEstimate>;
}
