import { EventSearchConfig, isDefined } from "../utils";
import { BaseAbstractClient, UpdateFailureReason } from "./BaseAbstractClient";
import winston from "winston";
import { getNearestSlotTime } from "../arch/svm/utils";
import { SVMProvider } from "../arch/svm";

/**
 * Base class for all SVM clients to extend.
 */
export abstract class BaseSvmAbstractClient extends BaseAbstractClient {
  constructor(
    readonly logger: winston.Logger,
    constructorParams: ConstructorParameters<typeof BaseAbstractClient>
  ) {
    super(...constructorParams);
  }

  /**
   * Validates and updates the stored EventSearchConfig in advance of an update() call.
   * Use isEventSearchConfig() to discriminate the result.
   * @provider Solana RPC provider instance.
   * @returns An EventSearchConfig instance if valid, otherwise an UpdateFailureReason.
   */
  public async updateSearchConfig(provider: SVMProvider): Promise<EventSearchConfig | UpdateFailureReason> {
    const from = this.firstHeightToSearch;
    let { to } = this.eventSearchConfig;
    if (isDefined(to)) {
      if (from > to) {
        throw new Error(`Invalid event search config from (${from}) > to (${to})`);
      }
    } else {
      const { slot } = await getNearestSlotTime(provider, this.logger);
      to = Number(slot);
      if (to < from) {
        return UpdateFailureReason.AlreadyUpdated;
      }
    }

    const { maxLookBack } = this.eventSearchConfig;
    return { from, to, maxLookBack };
  }
}
