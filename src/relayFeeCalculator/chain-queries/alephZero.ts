import assert from "assert";
import { getDeployedAddress } from "../../utils/DeploymentUtils";
import { DEFAULT_LOGGER, Logger } from "../relayFeeCalculator";
import { providers } from "ethers";
import { CHAIN_IDs, DEFAULT_SIMULATED_RELAYER_ADDRESS, TOKEN_SYMBOLS_MAP } from "../../constants";
import { Coingecko } from "../../coingecko/Coingecko";
import { isDefined } from "../../utils";
import { QueryBase } from "./baseQuery";

// @dev This class only exists because querying the native token price for this network is not the standard
// CoinGecko query because the native token symbol is not ETH.
export class AlephZeroQueries extends QueryBase {
  constructor(
    provider: providers.Provider,
    symbolMapping = TOKEN_SYMBOLS_MAP,
    spokePoolAddress = getDeployedAddress("SpokePool", CHAIN_IDs.ALEPH_ZERO),
    simulatedRelayerAddress = DEFAULT_SIMULATED_RELAYER_ADDRESS,
    coingeckoProApiKey?: string,
    logger: Logger = DEFAULT_LOGGER
  ) {
    assert(isDefined(spokePoolAddress));
    super(
      provider,
      symbolMapping,
      spokePoolAddress,
      simulatedRelayerAddress,
      logger,
      coingeckoProApiKey,
      undefined,
      "usd"
    );
  }

  override async getTokenPrice(tokenSymbol: string): Promise<number> {
    if (!this.symbolMapping[tokenSymbol]) throw new Error(`${tokenSymbol} does not exist in mapping`);
    const coingeckoInstance = Coingecko.get(this.logger, this.coingeckoProApiKey);
    const [, tokenPrice] = await coingeckoInstance.getCurrentPriceByContract(
      this.symbolMapping[tokenSymbol].addresses[CHAIN_IDs.MAINNET],
      "usd"
    );

    const [, alephZeroPrice] = await coingeckoInstance.getCurrentPriceByContract(
      this.symbolMapping["AZERO"].addresses[CHAIN_IDs.MAINNET],
      "usd"
    );
    return Number((tokenPrice / alephZeroPrice).toFixed(this.symbolMapping["AZERO"].decimals));
  }
}
