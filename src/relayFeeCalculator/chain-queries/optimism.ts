import { getDeployedAddress } from "../../utils/DeploymentUtils";
import { DEFAULT_LOGGER, Logger } from "../relayFeeCalculator";
import { providers } from "ethers";
import { TOKEN_SYMBOLS_MAP, CHAIN_IDs } from "../../constants";
import { asL2Provider } from "@eth-optimism/sdk/dist/l2-provider";
import QueryBase, { DEFAULT_SIMULATED_RELAYER_ADDRESS } from "./baseQuery";

export class OptimismQueries extends QueryBase {
  constructor(
    provider: providers.Provider,
    symbolMapping = TOKEN_SYMBOLS_MAP,
    spokePoolAddress = getDeployedAddress("SpokePool", CHAIN_IDs.OPTIMISM),
    usdcAddress = TOKEN_SYMBOLS_MAP.USDC.addresses[CHAIN_IDs.OPTIMISM],
    simulatedRelayerAddress = DEFAULT_SIMULATED_RELAYER_ADDRESS,
    coingeckoProApiKey?: string,
    logger: Logger = DEFAULT_LOGGER,
    gasMarkup = 0
  ) {
    super(
      asL2Provider(provider),
      symbolMapping,
      spokePoolAddress,
      usdcAddress,
      simulatedRelayerAddress,
      gasMarkup,
      logger,
      coingeckoProApiKey
    );
  }
}
