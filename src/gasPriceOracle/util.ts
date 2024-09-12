import { providers } from "ethers";
import { BigNumber } from "../utils";

export function gasPriceError(method: string, chainId: number, data: providers.FeeData | BigNumber): void {
  throw new Error(`Malformed ${method} response on chain ID ${chainId} (${JSON.stringify(data)})`);
}
