import { providers } from "ethers";
import { EventSearchConfig, isDefined } from "../utils";
import { BaseAbstractClient, UpdateFailureReason } from "./BaseAbstractClient";

/**
 * Base class for all EVM clients to extend.
 */
export abstract class BaseEvmAbstractClient extends BaseAbstractClient {
  constructor(constructorParams: ConstructorParameters<typeof BaseAbstractClient>) {
    super(...constructorParams);
  }

  /**
   * Validates and updates the stored EventSearchConfig in advance of an update() call.
   * Use isEventSearchConfig() to discriminate the result.
   * @provider Ethers RPC provider instance.
   * @returns An EventSearchConfig instance if valid, otherwise an UpdateFailureReason.
   */
  public async updateSearchConfig(provider: providers.Provider): Promise<EventSearchConfig | UpdateFailureReason> {
    const from = this.firstHeightToSearch;
    let { to } = this.eventSearchConfig;
    if (isDefined(to)) {
      if (from > to) {
        throw new Error(`Invalid event search config from (${from}) > to (${to})`);
      }
    } else {
      to = await provider.getBlockNumber();
      if (to < from) {
        return UpdateFailureReason.AlreadyUpdated;
      }
    }

    const { maxLookBack } = this.eventSearchConfig;
    return { from, to, maxLookBack };
  }
}
