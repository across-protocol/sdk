import { getDeployedAddress } from "../../utils/DeploymentUtils";
import { DEFAULT_LOGGER, Logger } from "../relayFeeCalculator";
import { providers } from "ethers";
import { CHAIN_IDs, DEFAULT_SIMULATED_RELAYER_ADDRESS, TOKEN_SYMBOLS_MAP } from "../../constants";
import { Coingecko } from "../../coingecko/Coingecko";
import QueryBase from "./baseQuery";

export class PolygonQueries extends QueryBase {
  constructor(
    provider: providers.Provider,
    symbolMapping = TOKEN_SYMBOLS_MAP,
    spokePoolAddress = getDeployedAddress("SpokePool", CHAIN_IDs.POLYGON),
    simulatedRelayerAddress = DEFAULT_SIMULATED_RELAYER_ADDRESS,
    coingeckoProApiKey?: string,
    logger: Logger = DEFAULT_LOGGER,
    gasMarkup = 0
  ) {
    super(
      provider,
      symbolMapping,
      spokePoolAddress,
      simulatedRelayerAddress,
      gasMarkup,
      logger,
      coingeckoProApiKey,
      undefined,
      "usd"
    );
  }

  async getTokenPrice(tokenSymbol: string): Promise<number> {
    if (!this.symbolMapping[tokenSymbol]) throw new Error(`${tokenSymbol} does not exist in mapping`);
    const coingeckoInstance = Coingecko.get(this.logger, this.coingeckoProApiKey);
    const [, tokenPrice] = await coingeckoInstance.getCurrentPriceByContract(
      this.symbolMapping[tokenSymbol].addresses[CHAIN_IDs.MAINNET],
      "usd"
    );

    const [, maticPrice] = await coingeckoInstance.getCurrentPriceByContract(
      this.symbolMapping["MATIC"].addresses[CHAIN_IDs.MAINNET],
      "usd"
    );
    return Number((tokenPrice / maticPrice).toFixed(this.symbolMapping["MATIC"].decimals));
  }
}

export class PolygonMumbaiQueries extends PolygonQueries {
  constructor(
    provider: providers.Provider,
    symbolMapping = TOKEN_SYMBOLS_MAP,
    spokePoolAddress = getDeployedAddress("SpokePool", CHAIN_IDs.MUMBAI),
    simulatedRelayerAddress = "0x9A8f92a830A5cB89a3816e3D267CB7791c16b04D",
    coingeckoProApiKey?: string,
    logger: Logger = DEFAULT_LOGGER,
    gasMarkup = 0
  ) {
    super(provider, symbolMapping, spokePoolAddress, simulatedRelayerAddress, coingeckoProApiKey, logger, gasMarkup);
  }
}
