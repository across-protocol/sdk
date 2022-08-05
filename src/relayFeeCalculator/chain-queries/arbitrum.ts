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
    readonly symbolMapping = SymbolMapping,
    spokePoolAddress = "0xB88690461dDbaB6f04Dfad7df66B7725942FEb9C",
    private readonly usdcAddress = "0xFF970A61A04b1cA14834A43f5dE4533eBDDB5CC8",
    private readonly simulatedRelayerAddress = "0x893d0d70ad97717052e3aa8903d9615804167759"
  ) {
    this.spokePool = ArbitrumSpokePool__factory.connect(spokePoolAddress, provider);
  }

  async getGasCosts(_tokenSymbol: string): Promise<BigNumberish> {
    const gasEstimate = await this.estimateGas();
    const gasPrice = BigNumber.from(await this.provider.getGasPrice());
    return gasPrice.mul(gasEstimate).toString();
  }

  async getTokenPrice(tokenSymbol: string): Promise<string | number> {
    if (!this.symbolMapping[tokenSymbol]) throw new Error(`${tokenSymbol} does not exist in mapping`);
    const [, price] = await Coingecko.get().getCurrentPriceByContract(this.symbolMapping[tokenSymbol].address, "eth");
    return price;
  }

  async getTokenDecimals(tokenSymbol: string): Promise<number> {
    if (!this.symbolMapping[tokenSymbol]) throw new Error(`${tokenSymbol} does not exist in mapping`);
    return this.symbolMapping[tokenSymbol].decimals;
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
