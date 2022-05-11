import { QueryInterface } from "../relayFeeCalculator";
import { BigNumberish } from "../../utils";
import ethers, { BigNumber } from "ethers";
import { SymbolMapping } from "./ethereum";
import { Coingecko } from "../../coingecko/Coingecko";
import { ArbitrumSpokePool__factory, ArbitrumSpokePool } from '@across-protocol/contracts-v2';

class ArbitrumQueryInterface implements QueryInterface {

  private spokePool: ArbitrumSpokePool;

  constructor(readonly provider: ethers.providers.Provider) {
    // TODO: replace with address getter.
    this.spokePool = ArbitrumSpokePool__factory.connect("0xe1C367e2b576Ac421a9f46C9cC624935730c36aa", provider);
  }
    
  async getGasCosts(tokenSymbol: string): Promise<BigNumberish> {
    const gasEstimate = await this.estimateGas();
    const gasPrice = BigNumber.from(await this.provider.getGasPrice());
    return gasPrice.mul(gasEstimate).toString();
  }

  async getTokenPrice(tokenSymbol: string): Promise<string | number> {
    const [, price] = await Coingecko.get().getCurrentPriceByContract(SymbolMapping[tokenSymbol].address, "eth");
    return price;
  }

  async getTokenDecimals(tokenSymbol: string): Promise<number> {
    return SymbolMapping[tokenSymbol].decimals;
  }

  estimateGas() {
      // Create a dummy transaction to estimate. Note: the simulated caller would need to be holding weth and have approved the contract.
      return this.spokePool.estimateGas.fillRelay("0x9a8f92a830a5cb89a3816e3d267cb7791c16b04d", "0x9a8f92a830a5cb89a3816e3d267cb7791c16b04d", "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1", "10", "10", "1", "1", "1", "1", "1", { from: "0x9a8f92a830a5cb89a3816e3d267cb7791c16b04d" });
  }
}