import { getDeployedAddress } from "@across-protocol/contracts-v2";
import { DEFAULT_LOGGER, Logger } from "../relayFeeCalculator";
import { providers } from "ethers";
import { TOKEN_SYMBOLS_MAP } from "../../constants";
import { asL2Provider } from "@eth-optimism/sdk/dist/l2-provider";
import { DEFAULT_SIMULATED_RELAYER_ADDRESS } from "./baseQuery";
import QueryBase from "./baseQuery";

const chainId = 10;

export class OptimismQueries extends QueryBase {
  constructor(
    provider: providers.Provider,
    symbolMapping = TOKEN_SYMBOLS_MAP,
    spokePoolAddress = getDeployedAddress("SpokePool", chainId),
    usdcAddress = TOKEN_SYMBOLS_MAP.USDC.addresses[chainId],
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
