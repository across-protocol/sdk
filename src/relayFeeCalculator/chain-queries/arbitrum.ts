import { QueryInterface } from "../relayFeeCalculator";
import { BigNumberish } from "../../utils";
import { BigNumber, providers } from "ethers";
import { SymbolMapping } from "./ethereum";
import { Coingecko } from "../../coingecko/Coingecko";
import { ArbitrumSpokePool__factory, ArbitrumSpokePool } from "@across-protocol/contracts-v2";

export class ArbitrumQueries implements QueryInterface {
  private spokePool: ArbitrumSpokePool;

  constructor(
    readonly provider: providers.Provider,
    spokePoolAddress = "0xe1C367e2b576Ac421a9f46C9cC624935730c36aa",
    private readonly usdcAddress = "0xFF970A61A04b1cA14834A43f5dE4533eBDDB5CC8",
    private readonly simulatedRelayerAddress = "0x9a8f92a830a5cb89a3816e3d267cb7791c16b04d"
  ) {
    this.spokePool = ArbitrumSpokePool__factory.connect(spokePoolAddress, provider);
  }

  async getGasCosts(_tokenSymbol: string): Promise<BigNumberish> {
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
    return this.spokePool.estimateGas.fillRelay(
      "0xBb23Cd0210F878Ea4CcA50e9dC307fb0Ed65Cf6B",
      "0xBb23Cd0210F878Ea4CcA50e9dC307fb0Ed65Cf6B",
      this.usdcAddress,
      "10",
      "10",
      "1",
      "1",
      "1",
      "1",
      "1",
      { from: this.simulatedRelayerAddress }
    );
  }
}
