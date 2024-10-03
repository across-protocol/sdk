import { providers } from "ethers";
import { BigNumber } from "../utils";

export type GasPriceEstimate = {
  maxFeePerGas: BigNumber;
  maxPriorityFeePerGas: BigNumber;
};

export interface GasPriceFeed {
  (provider: providers.Provider, chainId: number): Promise<GasPriceEstimate>;
}
