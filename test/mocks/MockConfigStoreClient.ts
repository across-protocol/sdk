import { clients } from "../../src";
import { EventSearchConfig, MakeOptional } from "../../src/utils";
import { Contract, winston } from "../utils";
import { CHAIN_ID_TEST_LIST } from "../constants";

export const DEFAULT_CONFIG_STORE_VERSION = clients.DEFAULT_CONFIG_STORE_VERSION;

// @dev This mocked class must re-implement any customisations in the local extended ConfigStoreClient.
export class MockConfigStoreClient extends clients.mocks.MockConfigStoreClient {
  constructor(
    logger: winston.Logger,
    configStore: Contract,
    eventSearchConfig: MakeOptional<EventSearchConfig, "to"> = { from: 0, maxLookBack: 0 },
    configStoreVersion = DEFAULT_CONFIG_STORE_VERSION,
    enabledChainIds = CHAIN_ID_TEST_LIST,
    chainId = 1,
    mockUpdate = false
  ) {
    super(
      logger,
      configStore,
      eventSearchConfig as EventSearchConfig,
      configStoreVersion,
      chainId,
      mockUpdate,
      enabledChainIds
    );
  }
}
