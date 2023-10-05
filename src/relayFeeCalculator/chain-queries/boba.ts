import { DEFAULT_LOGGER, Logger } from "../relayFeeCalculator";
import { utils, providers } from "ethers";
import QueryBase from "./baseQuery";
import { CHAIN_IDs, DEFAULT_SIMULATED_RELAYER_ADDRESS, TOKEN_SYMBOLS_MAP } from "../../constants";
import { getDeployedAddress } from "../../utils/DeploymentUtils";

export class BobaQueries extends QueryBase {
  constructor(
    provider: providers.Provider,
    symbolMapping = TOKEN_SYMBOLS_MAP,
    spokePoolAddress = getDeployedAddress("SpokePool", CHAIN_IDs.BOBA),
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
      utils.parseUnits("1", 9)
    );
  }
}
