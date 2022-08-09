import { providers } from "ethers";
import { SymbolMapping } from "./ethereum";
import { Coingecko } from "../../coingecko/Coingecko";
import { BaseQuery } from "./baseQuery";

export class PolygonQueries extends BaseQuery {
  constructor(
    provider: providers.Provider,
    symbolMapping = SymbolMapping,
    spokePoolAddress = "0x69B5c72837769eF1e7C164Abc6515DcFf217F920",
    usdcAddress = "0x2791bca1f2de4661ed88a30c99a7a9449aa84174",
    simulatedRelayerAddress = "0x893d0D70AD97717052E3AA8903D9615804167759",
    gasMultiplier = 0
  ) {
    super(
      provider,
      symbolMapping,
      spokePoolAddress,
      usdcAddress,
      simulatedRelayerAddress,
      gasMultiplier,
      undefined,
      "usd"
    );
  }

  async getTokenPrice(tokenSymbol: string): Promise<string | number> {
    // Retrieves the token price of USDC in USD
    const tokenPrice = Number(await super.getTokenPrice(tokenSymbol));

    const [, maticPrice] = await Coingecko.get().getCurrentPriceByContract(this.symbolMapping["MATIC"].address, "usd");
    return Number((tokenPrice / maticPrice).toFixed(this.symbolMapping["MATIC"].decimals));
  }
}
