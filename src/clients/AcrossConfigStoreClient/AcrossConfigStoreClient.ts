import assert from "assert";
import { utils } from "@uma/sdk";
import { isError } from "../../typeguards";
import {
  isDefined,
  spreadEvent,
  sortEventsAscendingInPlace,
  sortEventsDescending,
  spreadEventWithBlockNumber,
  paginatedEventQuery,
  EventSearchConfig,
  utf8ToHex,
  MakeOptional,
  toBN,
  max,
  sortEventsAscending,
  findLast,
  UBA_MIN_CONFIG_STORE_VERSION,
} from "../../utils";
import { Contract, BigNumber, Event } from "ethers";
import winston from "winston";

import {
  L1TokenTransferThreshold,
  L1TokenTransferThresholdStringified,
  TokenConfig,
  GlobalConfigUpdate,
  ParsedTokenConfig,
  SpokeTargetBalanceUpdate,
  SpokePoolTargetBalance,
  RouteRateModelUpdate,
  ConfigStoreVersionUpdate,
  DisabledChainsUpdate,
  UBAConfigUpdates,
  UBAParsedConfigType,
  UBASerializedConfigUpdates,
  SpokeTargetBalanceUpdateStringified,
} from "../../interfaces";
import { across } from "@uma/sdk";
import { parseUBAConfigFromOnChain } from "./ConfigStoreParsingUtilities";
import { BaseAbstractClient } from "../BaseAbstractClient";
import { parseJSONWithNumericString, stringifyJSONWithNumericString } from "../../utils/JSONUtils";

type _ConfigStoreUpdate = {
  success: true;
  latestBlockNumber: number;
  searchEndBlock: number;
  events: {
    updatedTokenConfigEvents: Event[];
    updatedGlobalConfigEvents: Event[];
    globalConfigUpdateTimes: number[];
  };
};
export type ConfigStoreUpdate = { success: false } | _ConfigStoreUpdate;

// Version 0 is the implicit ConfigStore version from before the version attribute was introduced.
// @dev Do not change this value.
export const DEFAULT_CONFIG_STORE_VERSION = 0;

export enum GLOBAL_CONFIG_STORE_KEYS {
  MAX_RELAYER_REPAYMENT_LEAF_SIZE = "MAX_RELAYER_REPAYMENT_LEAF_SIZE",
  MAX_POOL_REBALANCE_LEAF_SIZE = "MAX_POOL_REBALANCE_LEAF_SIZE",
  VERSION = "VERSION",
  DISABLED_CHAINS = "DISABLED_CHAINS",
  CHAIN_ID_INDICES = "CHAIN_ID_INDICES",
}

export class AcrossConfigStoreClient extends BaseAbstractClient {
  public cumulativeRateModelUpdates: across.rateModel.RateModelEvent[] = [];
  public ubaConfigUpdates: UBAConfigUpdates[] = [];
  public cumulativeRouteRateModelUpdates: RouteRateModelUpdate[] = [];
  public cumulativeTokenTransferUpdates: L1TokenTransferThreshold[] = [];
  public cumulativeMaxRefundCountUpdates: GlobalConfigUpdate[] = [];
  public cumulativeMaxL1TokenCountUpdates: GlobalConfigUpdate[] = [];
  public chainIdIndicesUpdates: GlobalConfigUpdate<number[]>[] = [];
  public cumulativeSpokeTargetBalanceUpdates: SpokeTargetBalanceUpdate[] = [];
  public cumulativeConfigStoreVersionUpdates: ConfigStoreVersionUpdate[] = [];
  public cumulativeDisabledChainUpdates: DisabledChainsUpdate[] = [];

  protected rateModelDictionary: across.rateModel.RateModelDictionary;
  public firstBlockToSearch: number;
  public latestBlockNumber = 0;

  public hasLatestConfigStoreVersion = false;

  constructor(
    readonly logger: winston.Logger,
    readonly configStore: Contract,
    readonly eventSearchConfig: MakeOptional<EventSearchConfig, "toBlock"> = { fromBlock: 0, maxBlockLookBack: 0 },
    readonly configStoreVersion: number
  ) {
    super();
    this.firstBlockToSearch = eventSearchConfig.fromBlock;
    this.rateModelDictionary = new across.rateModel.RateModelDictionary();
  }

  // <-- START LEGACY CONFIGURATION OBJECTS -->
  // @dev The following configuration objects are pre-UBA fee model configurations and are deprecated as of version
  // 2 of the ConfigStore. They are kept here for backwards compatibility.

  getRateModelForBlockNumber(
    l1Token: string,
    originChainId: number | string,
    destinationChainId: number | string,
    blockNumber: number | undefined = undefined
  ): across.constants.RateModel {
    // Use route-rate model if available, otherwise use default rate model for l1Token.
    const route = `${originChainId}-${destinationChainId}`;
    const routeRateModel = this.getRouteRateModelForBlockNumber(l1Token, route, blockNumber);
    return routeRateModel ?? this.rateModelDictionary.getRateModelForBlockNumber(l1Token, blockNumber);
  }

  getRouteRateModelForBlockNumber(
    l1Token: string,
    route: string,
    blockNumber: number | undefined = undefined
  ): across.constants.RateModel | undefined {
    const config = (sortEventsDescending(this.cumulativeRouteRateModelUpdates) as RouteRateModelUpdate[]).find(
      (config) => config.blockNumber <= (blockNumber ?? 0) && config.l1Token === l1Token
    );
    if (config?.routeRateModel[route] === undefined) {
      return undefined;
    }
    return across.rateModel.parseAndReturnRateModelFromString(config.routeRateModel[route]);
  }

  getChainIdIndicesForBlock(blockNumber: number = Number.MAX_SAFE_INTEGER): number[] {
    const config = (sortEventsDescending(this.chainIdIndicesUpdates) as GlobalConfigUpdate<number[]>[]).find(
      (config) => config.blockNumber <= blockNumber
    );
    return config?.value ?? [1, 10, 137, 288, 42161];
  }

  getTokenTransferThresholdForBlock(l1Token: string, blockNumber: number = Number.MAX_SAFE_INTEGER): BigNumber {
    const config = (sortEventsDescending(this.cumulativeTokenTransferUpdates) as L1TokenTransferThreshold[]).find(
      (config) => config.blockNumber <= blockNumber && config.l1Token === l1Token
    );
    if (!config) {
      throw new Error(`Could not find TransferThreshold for L1 token ${l1Token} before block ${blockNumber}`);
    }
    return config.transferThreshold;
  }

  getSpokeTargetBalancesForBlock(
    l1Token: string,
    chainId: number,
    blockNumber: number = Number.MAX_SAFE_INTEGER
  ): SpokePoolTargetBalance {
    const config = (sortEventsDescending(this.cumulativeSpokeTargetBalanceUpdates) as SpokeTargetBalanceUpdate[]).find(
      (config) => config.l1Token === l1Token && config.blockNumber <= blockNumber
    );
    const targetBalance = config?.spokeTargetBalances?.[chainId];
    return targetBalance || { target: toBN(0), threshold: toBN(0) };
  }
  // <-- END LEGACY CONFIGURATION OBJECTS -->

  getMaxRefundCountForRelayerRefundLeafForBlock(blockNumber: number = Number.MAX_SAFE_INTEGER): number {
    const config = (sortEventsDescending(this.cumulativeMaxRefundCountUpdates) as GlobalConfigUpdate[]).find(
      (config) => config.blockNumber <= blockNumber
    );
    if (!config) {
      throw new Error(`Could not find MaxRefundCount before block ${blockNumber}`);
    }
    return Number(config.value);
  }

  getMaxL1TokenCountForPoolRebalanceLeafForBlock(blockNumber: number = Number.MAX_SAFE_INTEGER): number {
    const config = (sortEventsDescending(this.cumulativeMaxL1TokenCountUpdates) as GlobalConfigUpdate[]).find(
      (config) => config.blockNumber <= blockNumber
    );
    if (!config) {
      throw new Error(`Could not find MaxL1TokenCount before block ${blockNumber}`);
    }
    return Number(config.value);
  }

  /**
   * Returns list of chains that have been enabled at least once in the block range.
   * If a chain was disabled in the block range, it will be included in the list provided it was enabled
   * at some point in the block range.
   * @dev If fromBlock == toBlock then defaults to returning enabled chains at fromBlock
   * @param fromBlock Start block to search inclusive
   * @param toBlock End block to search inclusive. Defaults to MAX_SAFE_INTEGER, so grabs all disabled chain events
   * up until `latest`.
   * @param allPossibleChains Returned list will be a subset of this list.
   * @returns List of chain IDs that have been enabled at least once in the block range. Sorted from lowest to highest.
   */
  getEnabledChainsInBlockRange(fromBlock: number, toBlock = Number.MAX_SAFE_INTEGER): number[] {
    if (toBlock < fromBlock) {
      throw new Error(`Invalid block range: fromBlock ${fromBlock} > toBlock ${toBlock}`);
    }
    // Initiate list with all chains enabled at the fromBlock.
    const disabledChainsAtFromBlock = this.getDisabledChainsForBlock(fromBlock);
    const enabledChainsAtFromBlock = this.getChainIdIndicesForBlock(fromBlock).filter(
      (chainId) => !disabledChainsAtFromBlock.includes(chainId)
    );

    // Update list of enabled chains with any of the candidate chains that have been removed from the
    // disabled list during the block range.
    return sortEventsAscending(this.cumulativeDisabledChainUpdates)
      .reduce((enabledChains: number[], disabledChainUpdate) => {
        if (disabledChainUpdate.blockNumber > toBlock || disabledChainUpdate.blockNumber < fromBlock) {
          return enabledChains;
        }
        // If any of the possible chains are not listed in this disabled chain update and are not already in the
        // enabled chain list, then add them to the list.
        this.getChainIdIndicesForBlock(disabledChainUpdate.blockNumber).forEach((chainId) => {
          if (!disabledChainUpdate.chainIds.includes(chainId) && !enabledChains.includes(chainId)) {
            enabledChains.push(chainId);
          }
        });
        return enabledChains;
      }, enabledChainsAtFromBlock)
      .sort((a, b) => a - b);
  }

  getEnabledChains(block = Number.MAX_SAFE_INTEGER): number[] {
    // Get most recent disabled chain list before the block specified.
    const currentlyDisabledChains = this.getDisabledChainsForBlock(block);
    return this.getChainIdIndicesForBlock(block).filter((chainId) => !currentlyDisabledChains.includes(chainId));
  }

  getDisabledChainsForBlock(blockNumber: number = Number.MAX_SAFE_INTEGER): number[] {
    return (
      sortEventsDescending(this.cumulativeDisabledChainUpdates).find((config) => config.blockNumber <= blockNumber)
        ?.chainIds ?? []
    );
  }

  getConfigStoreVersionForTimestamp(timestamp: number = Number.MAX_SAFE_INTEGER): number {
    const config = this.cumulativeConfigStoreVersionUpdates.find((config) => config.timestamp <= timestamp);
    return isDefined(config) ? Number(config.value) : DEFAULT_CONFIG_STORE_VERSION;
  }

  getUBAActivationBlock(): number | undefined {
    return this.cumulativeConfigStoreVersionUpdates.find((config) => {
      return Number(config.value) >= UBA_MIN_CONFIG_STORE_VERSION;
    })?.blockNumber;
  }

  getConfigStoreVersionForBlock(blockNumber: number = Number.MAX_SAFE_INTEGER): number {
    const config = this.cumulativeConfigStoreVersionUpdates.find((config) => config.blockNumber <= blockNumber);
    return isDefined(config) ? Number(config.value) : DEFAULT_CONFIG_STORE_VERSION;
  }

  hasValidConfigStoreVersionForTimestamp(timestamp: number = Number.MAX_SAFE_INTEGER): boolean {
    const version = this.getConfigStoreVersionForTimestamp(timestamp);
    return this.configStoreVersion >= version;
  }

  async _update(): Promise<ConfigStoreUpdate> {
    const latestBlockNumber = await this.configStore.provider.getBlockNumber();
    const searchConfig = {
      fromBlock: this.firstBlockToSearch,
      toBlock: this.eventSearchConfig.toBlock || latestBlockNumber,
      maxBlockLookBack: this.eventSearchConfig.maxBlockLookBack,
    };

    if (searchConfig.fromBlock > searchConfig.toBlock) {
      this.logger.warn({ at: "ConfigStore", message: "Invalid search config.", searchConfig, latestBlockNumber });
      return { success: false };
    }

    const [updatedTokenConfigEvents, updatedGlobalConfigEvents] = await Promise.all([
      paginatedEventQuery(this.configStore, this.configStore.filters.UpdatedTokenConfig(), searchConfig),
      paginatedEventQuery(this.configStore, this.configStore.filters.UpdatedGlobalConfig(), searchConfig),
    ]);

    // Events *should* normally be received in ascending order, but explicitly enforce the ordering.
    [updatedTokenConfigEvents, updatedGlobalConfigEvents].forEach((events) => sortEventsAscendingInPlace(events));

    const globalConfigUpdateTimes = (
      await Promise.all(updatedGlobalConfigEvents.map((event) => this.configStore.provider.getBlock(event.blockNumber)))
    ).map((block) => block.timestamp);

    return {
      success: true,
      latestBlockNumber,
      searchEndBlock: searchConfig.toBlock,
      events: {
        updatedTokenConfigEvents,
        updatedGlobalConfigEvents,
        globalConfigUpdateTimes,
      },
    };
  }

  async update(): Promise<void> {
    this.logger.debug({ at: "ConfigStore", message: "Updating ConfigStore client" });

    const result = await this._update();
    if (!result.success) {
      return;
    }
    const { updatedTokenConfigEvents, updatedGlobalConfigEvents, globalConfigUpdateTimes } = result.events;
    assert(
      updatedGlobalConfigEvents.length === globalConfigUpdateTimes.length,
      `GlobalConfigUpdate events mismatch (${updatedGlobalConfigEvents.length} != ${globalConfigUpdateTimes.length})`
    );

    // Save new TokenConfig updates.
    for (const event of updatedTokenConfigEvents) {
      const args = {
        ...(spreadEventWithBlockNumber(event) as TokenConfig),
      };

      try {
        const parsedValue = parseJSONWithNumericString(args.value) as ParsedTokenConfig;

        const l1Token = args.key;

        // For now use the presence of `uba` or `rateModel` to decide which configs to parse.
        if (parsedValue?.uba !== undefined) {
          try {
            // Parse and store UBA config
            const ubaConfig = parseUBAConfigFromOnChain(parsedValue.uba);
            // eslint-disable-next-line @typescript-eslint/no-unused-vars
            const { value: _value, key: _key, ...passedArgs } = args;
            this.logger.debug({
              at: "ConfigStore::update",
              message: `Parsed UBA config for ${l1Token}`,
              ubaConfig,
            });
            this.ubaConfigUpdates.push({ ...passedArgs, config: ubaConfig, l1Token });
          } catch (e) {
            this.logger.warn({
              at: "ConfigStore::update",
              message: `Failed to parse UBA config for ${l1Token}`,
              error: {
                message: (e as Error)?.message,
                stack: (e as Error)?.stack,
              },
            });
          }
        }

        // TODO: Temporarily reformat the shape of the event that we pass into the sdk.rateModel class to make it fit
        // the expected shape. This is a fix for now that we should eventually replace when we change the sdk.rateModel
        // class itself to work with the generalized ConfigStore.
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        const { value, key, ...passedArgs } = args;

        // Drop value and key before passing args.
        if (parsedValue?.rateModel !== undefined) {
          const rateModelForToken = JSON.stringify(parsedValue.rateModel);
          this.cumulativeRateModelUpdates.push({ ...passedArgs, rateModel: rateModelForToken, l1Token });

          if (parsedValue?.transferThreshold !== undefined) {
            const transferThresholdForToken = parsedValue.transferThreshold;
            this.cumulativeTokenTransferUpdates.push({
              ...passedArgs,
              transferThreshold: toBN(transferThresholdForToken),
              l1Token,
            });
          }

          // Store spokeTargetBalances
          if (parsedValue?.spokeTargetBalances) {
            // Note: cast is required because fromEntries always produces string keys, despite the function returning a
            // numerical key.
            const targetBalances = Object.fromEntries(
              Object.entries(parsedValue.spokeTargetBalances).map(([chainId, targetBalance]) => {
                const target = max(toBN(targetBalance.target), toBN(0));
                const threshold = max(toBN(targetBalance.threshold), toBN(0));
                return [chainId, { target, threshold }];
              })
            ) as SpokeTargetBalanceUpdate["spokeTargetBalances"];
            this.cumulativeSpokeTargetBalanceUpdates.push({
              ...passedArgs,
              spokeTargetBalances: targetBalances,
              l1Token,
            });
          } else {
            this.cumulativeSpokeTargetBalanceUpdates.push({ ...passedArgs, spokeTargetBalances: {}, l1Token });
          }

          // Store route-specific rate models
          if (parsedValue?.routeRateModel) {
            const routeRateModel = Object.fromEntries(
              Object.entries(parsedValue.routeRateModel).map(([path, routeRateModel]) => {
                return [path, JSON.stringify(routeRateModel)];
              })
            );
            this.cumulativeRouteRateModelUpdates.push({ ...passedArgs, routeRateModel, l1Token });
          } else {
            this.cumulativeRouteRateModelUpdates.push({ ...passedArgs, routeRateModel: {}, l1Token });
          }
        }
      } catch (err) {
        // @dev averageBlockTimeSeconds does not actually block.
        const maxWarnAge = (24 * 60 * 60) / (await utils.averageBlockTimeSeconds());
        if (result.latestBlockNumber - event.blockNumber < maxWarnAge) {
          const errMsg = isError(err) ? err.message : "unknown error";
          this.logger.warn({
            at: "ConfigStore::update",
            message: `Caught error during ConfigStore update: ${errMsg}`,
            update: args,
          });
        } else {
          this.logger.debug({
            at: "ConfigStoreClient::update",
            message: `Skipping invalid historical update at block ${event.blockNumber}`,
          });
        }
        continue;
      }
    }
    sortEventsAscendingInPlace(this.ubaConfigUpdates);

    // Save new Global config updates.
    for (let i = 0; i < updatedGlobalConfigEvents.length; i++) {
      const event = updatedGlobalConfigEvents[i];
      const args = {
        blockNumber: event.blockNumber,
        transactionIndex: event.transactionIndex,
        logIndex: event.logIndex,
        ...spreadEvent(event.args),
      };

      if (args.key === utf8ToHex(GLOBAL_CONFIG_STORE_KEYS.MAX_RELAYER_REPAYMENT_LEAF_SIZE)) {
        if (!isNaN(args.value)) {
          this.cumulativeMaxRefundCountUpdates.push(args);
        }
      } else if (args.key === utf8ToHex(GLOBAL_CONFIG_STORE_KEYS.CHAIN_ID_INDICES)) {
        // First remove out all the spaces
        const rawChainIndices = String(args.value).replace(/\s/g, "");
        // Sanity check to verify that this is a string representation of an array of
        // positive integers. Let's confirm this via a regex.
        if (!rawChainIndices.match(/^\[[0-9,]+\]$/)) {
          this.logger.warn({ at: "ConfigStore", message: `The array ${rawChainIndices} is invalid.` });
          // If not a valid array, skip.
          continue;
        }
        // Let's parse this via JSON.parse. Since we've passed the regex check, we can
        // be sure that this is a valid array of positive integers.
        const chainIndices = JSON.parse(rawChainIndices) as number[];
        // If all else passes, we can add this update.
        this.chainIdIndicesUpdates.push({ ...args, value: chainIndices });
      } else if (args.key === utf8ToHex(GLOBAL_CONFIG_STORE_KEYS.MAX_POOL_REBALANCE_LEAF_SIZE)) {
        if (!isNaN(args.value)) {
          this.cumulativeMaxL1TokenCountUpdates.push(args);
        }
      } else if (args.key === utf8ToHex(GLOBAL_CONFIG_STORE_KEYS.VERSION)) {
        // If not a number, skip.
        if (isNaN(args.value)) {
          continue;
        }
        const value = Number(args.value);

        // If not an integer, skip.
        if (!Number.isInteger(value)) {
          continue;
        }

        // Extract the current highest version. Require that the version always increments, otherwise skip the update.
        const lastValue = Number(this.cumulativeConfigStoreVersionUpdates[0]?.value ?? DEFAULT_CONFIG_STORE_VERSION);
        if (value <= lastValue) {
          continue;
        }

        // Prepend the update to impose descending ordering for version updates.
        this.cumulativeConfigStoreVersionUpdates = [
          { ...args, timestamp: globalConfigUpdateTimes[i] },
          ...this.cumulativeConfigStoreVersionUpdates,
        ];
      } else if (args.key === utf8ToHex(GLOBAL_CONFIG_STORE_KEYS.DISABLED_CHAINS)) {
        try {
          const chainIds = this.filterDisabledChains(JSON.parse(args.value) as number[]);
          this.cumulativeDisabledChainUpdates.push({ ...args, chainIds });
        } catch (err) {
          // Can't parse list, skip.
        }
      } else {
        continue;
      }
    }

    this.rateModelDictionary.updateWithEvents(this.cumulativeRateModelUpdates);

    this.hasLatestConfigStoreVersion = this.hasValidConfigStoreVersionForTimestamp();
    this.latestBlockNumber = result.latestBlockNumber;
    this.firstBlockToSearch = result.searchEndBlock + 1; // Next iteration should start off from where this one ended.
    this.isUpdated = true;

    this.logger.debug({ at: "ConfigStore", message: "ConfigStore client updated!" });
  }

  filterDisabledChains(disabledChains: number[]): number[] {
    // If any chain ID's are not integers then ignore. UMIP-157 requires that this key cannot include
    // the chain ID 1.
    return disabledChains.filter((chainId: number) => !isNaN(chainId) && Number.isInteger(chainId) && chainId !== 1);
  }

  /**
   * Retrieves the most recently set UBA config for a given L1 token address before a block number.
   * @param l1TokenAddress The L1 token address to retrieve the config for
   * @param blockNumber The block number to retrieve the config for. If not specified, sets block to max integer
   * meaning that this function will return the latest config.
   * @returns The UBA config for the given L1 token address and block number, or undefined if no config exists
   * before blockNumber.
   */
  public getUBAConfig(l1TokenAddress: string, blockNumber = Number.MAX_SAFE_INTEGER): UBAParsedConfigType | undefined {
    // We only care about searching on the block number and not any events that occurred in the same block
    // but with a lower transaction index. In other words, if the UBA config was updated as the absolute
    // last transaction in a block, the update still applies to all preceding UBA events in the same block.
    // This is a simplifying assumption that we can make because the ConfigStore admin role is whitelisted and assumed
    // to be acting in the best interest of the protocol.
    const config = findLast(
      this.ubaConfigUpdates,
      (config) => config.l1Token === l1TokenAddress && config.blockNumber <= blockNumber
    );
    return config?.config;
  }

  public updateFromJSON(configStoreClientState: Partial<ReturnType<AcrossConfigStoreClient["toJSON"]>>) {
    const keysToUpdate = Object.keys(configStoreClientState);

    this.logger.debug({
      at: "ConfigStoreClient",
      message: "Updating ConfigStoreClient from JSON",
      keys: keysToUpdate,
    });

    if (keysToUpdate.length === 0) {
      return;
    }

    const {
      cumulativeRateModelUpdates = this.cumulativeRateModelUpdates,
      cumulativeRouteRateModelUpdates = this.cumulativeRouteRateModelUpdates,
      cumulativeMaxRefundCountUpdates = this.cumulativeMaxRefundCountUpdates,
      cumulativeMaxL1TokenCountUpdates = this.cumulativeMaxL1TokenCountUpdates,
      cumulativeConfigStoreVersionUpdates = this.cumulativeConfigStoreVersionUpdates,
      cumulativeDisabledChainUpdates = this.cumulativeDisabledChainUpdates,
      firstBlockToSearch = this.firstBlockToSearch,
      hasLatestConfigStoreVersion = this.hasLatestConfigStoreVersion,
      latestBlockNumber = this.latestBlockNumber,
      ubaConfigUpdates,
      cumulativeTokenTransferUpdates,
      cumulativeSpokeTargetBalanceUpdates,
    } = configStoreClientState;

    this.cumulativeRateModelUpdates = cumulativeRateModelUpdates;
    this.ubaConfigUpdates = ubaConfigUpdates
      ? ubaConfigUpdates.map((update) => {
          return {
            ...update,
            config: parseUBAConfigFromOnChain(update.config),
          };
        })
      : this.ubaConfigUpdates;
    this.cumulativeRouteRateModelUpdates = cumulativeRouteRateModelUpdates;
    this.cumulativeTokenTransferUpdates = cumulativeTokenTransferUpdates
      ? cumulativeTokenTransferUpdates.map((update) => {
          return {
            ...update,
            transferThreshold: BigNumber.from(update.transferThreshold),
          };
        })
      : this.cumulativeTokenTransferUpdates;
    this.cumulativeMaxRefundCountUpdates = cumulativeMaxRefundCountUpdates;
    this.cumulativeMaxL1TokenCountUpdates = cumulativeMaxL1TokenCountUpdates;
    this.cumulativeSpokeTargetBalanceUpdates = cumulativeSpokeTargetBalanceUpdates
      ? cumulativeSpokeTargetBalanceUpdates.map((update) => {
          return {
            ...update,
            spokeTargetBalances: Object.entries(update.spokeTargetBalances || {}).reduce(
              (acc, [chainId, { target, threshold }]) => ({
                ...acc,
                [chainId]: { target: BigNumber.from(target), threshold: BigNumber.from(threshold) },
              }),
              {}
            ),
          };
        })
      : [];
    this.cumulativeConfigStoreVersionUpdates = cumulativeConfigStoreVersionUpdates;
    this.cumulativeDisabledChainUpdates = cumulativeDisabledChainUpdates;
    this.firstBlockToSearch = firstBlockToSearch;
    this.hasLatestConfigStoreVersion = hasLatestConfigStoreVersion;
    this.latestBlockNumber = latestBlockNumber;
    this.rateModelDictionary.updateWithEvents(cumulativeRateModelUpdates);
    this.isUpdated = true;
  }

  public toJSON() {
    return {
      eventSearchConfig: this.eventSearchConfig,
      configStoreVersion: this.configStoreVersion,
      enabledChainIds: this.chainIdIndicesUpdates,
      cumulativeRateModelUpdates: this.cumulativeRateModelUpdates,
      ubaConfigUpdates: JSON.parse(
        stringifyJSONWithNumericString(this.ubaConfigUpdates)
      ) as UBASerializedConfigUpdates[],
      cumulativeRouteRateModelUpdates: this.cumulativeRouteRateModelUpdates,
      cumulativeTokenTransferUpdates: JSON.parse(
        stringifyJSONWithNumericString(this.cumulativeTokenTransferUpdates)
      ) as L1TokenTransferThresholdStringified[],
      cumulativeMaxRefundCountUpdates: this.cumulativeMaxRefundCountUpdates,
      cumulativeMaxL1TokenCountUpdates: this.cumulativeMaxL1TokenCountUpdates,
      cumulativeSpokeTargetBalanceUpdates: JSON.parse(
        stringifyJSONWithNumericString(this.cumulativeSpokeTargetBalanceUpdates)
      ) as SpokeTargetBalanceUpdateStringified[],
      cumulativeConfigStoreVersionUpdates: this.cumulativeConfigStoreVersionUpdates,
      cumulativeDisabledChainUpdates: this.cumulativeDisabledChainUpdates,
      firstBlockToSearch: this.firstBlockToSearch,
      latestBlockNumber: this.latestBlockNumber,
      hasLatestConfigStoreVersion: this.hasLatestConfigStoreVersion,
    };
  }
}
