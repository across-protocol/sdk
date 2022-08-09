import { providers } from "ethers";
import { SymbolMapping } from "./ethereum";
import { BaseQuery } from "./baseQuery";

export class ArbitrumQueries extends BaseQuery {
  constructor(
    provider: providers.Provider,
    symbolMapping = SymbolMapping,
    spokePoolAddress = "0xB88690461dDbaB6f04Dfad7df66B7725942FEb9C",
    usdcAddress = "0xFF970A61A04b1cA14834A43f5dE4533eBDDB5CC8",
    simulatedRelayerAddress = "0x893d0d70ad97717052e3aa8903d9615804167759",
    gasMultiplier = 0
  ) {
    super(provider, symbolMapping, spokePoolAddress, usdcAddress, simulatedRelayerAddress, gasMultiplier);
  }
}
