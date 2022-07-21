import { QueryInterface } from "../relayFeeCalculator";
import { BigNumberish } from "../../utils";
import { providers, VoidSigner } from "ethers";
import { SymbolMapping } from "./ethereum";
import { Coingecko } from "../../coingecko/Coingecko";
import { OptimismSpokePool__factory, OptimismSpokePool } from "@across-protocol/contracts-v2";

import { L2Provider, asL2Provider } from "@eth-optimism/sdk";

export class OptimismQueries implements QueryInterface {
  private spokePool: OptimismSpokePool;
  private provider: L2Provider<providers.Provider>;

  constructor(
    provider: providers.Provider,
    readonly symbolMapping = SymbolMapping,
    spokePoolAddress = "0x59485d57EEcc4058F7831f46eE83a7078276b4AE",
    private readonly usdcAddress = "0x7F5c764cBc14f9669B88837ca1490cCa17c31607",
    private readonly simulatedRelayerAddress = "0x893d0d70ad97717052e3aa8903d9615804167759"
  ) {
    this.provider = asL2Provider(provider);
    this.spokePool = OptimismSpokePool__factory.connect(spokePoolAddress, provider);
  }

  async getGasCosts(_tokenSymbol: string): Promise<BigNumberish> {
    // Create a dummy transaction to estimate. Note: the simulated caller would need to be holding weth and have approved the contract.
    const tx = await this.spokePool.populateTransaction.fillRelay(
      "0xBb23Cd0210F878Ea4CcA50e9dC307fb0Ed65Cf6B",
      "0xBb23Cd0210F878Ea4CcA50e9dC307fb0Ed65Cf6B",
      this.usdcAddress,
      "10",
      "10",
      "1",
      "1",
      "1",
      "1",
      "1"
    );
    const populatedTransaction = await new VoidSigner(this.simulatedRelayerAddress, this.provider).populateTransaction(
      tx
    );
    return (await this.provider.estimateTotalGasCost(populatedTransaction)).toString();
  }

  async getTokenPrice(tokenSymbol: string): Promise<number> {
    if (!this.symbolMapping[tokenSymbol]) throw new Error(`${tokenSymbol} does not exist in mapping`);
    const [, price] = await Coingecko.get().getCurrentPriceByContract(this.symbolMapping[tokenSymbol].address, "eth");
    return price;
  }

  async getTokenDecimals(tokenSymbol: string): Promise<number> {
    if (!this.symbolMapping[tokenSymbol]) throw new Error(`${tokenSymbol} does not exist in mapping`);
    return this.symbolMapping[tokenSymbol].decimals;
  }
}
