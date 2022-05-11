import { QueryInterface } from "../relayFeeCalculator";
import { BigNumberish } from "../../utils";
import ethers from "ethers";
import { SymbolMapping } from "./ethereum";
import { Coingecko } from "../../coingecko/Coingecko";
import { OptimismSpokePool__factory, OptimismSpokePool } from '@across-protocol/contracts-v2';

import sdk from "@eth-optimism/sdk";

class OptimismQueryInterface implements QueryInterface {

  private spokePool: OptimismSpokePool;
  private provider: sdk.L2Provider<ethers.providers.Provider>;

  constructor(provider: ethers.providers.Provider) {
    this.provider = sdk.asL2Provider(provider);
    // TODO: replace with address getter.
    this.spokePool = OptimismSpokePool__factory.connect("0x59485d57EEcc4058F7831f46eE83a7078276b4AE", provider);
  }
    
  async getGasCosts(tokenSymbol: string): Promise<BigNumberish> {
      // Create a dummy transaction to estimate. Note: the simulated caller would need to be holding weth and have approved the contract.
      const tx = await this.spokePool.populateTransaction.fillRelay("0x9a8f92a830a5cb89a3816e3d267cb7791c16b04d", "0x9a8f92a830a5cb89a3816e3d267cb7791c16b04d", "0x4200000000000000000000000000000000000006", "10", "10", "1", "1", "1", "1", "1");
      const populatedTransaction = await new ethers.VoidSigner("0x9a8f92a830a5cb89a3816e3d267cb7791c16b04d", this.provider).populateTransaction(tx);
      return (await this.provider.estimateTotalGasCost(populatedTransaction)).toString();
  }

  async getTokenPrice(tokenSymbol: string): Promise<string | number> {
    const [, price] = await Coingecko.get().getCurrentPriceByContract(SymbolMapping[tokenSymbol].address, "eth");
    return price;
  }

  async getTokenDecimals(tokenSymbol: string): Promise<number> {
    return SymbolMapping[tokenSymbol].decimals;
  }
}