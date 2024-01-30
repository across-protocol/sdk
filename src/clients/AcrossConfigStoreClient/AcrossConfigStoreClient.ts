import { utils, across } from "@uma/sdk";
import assert from "assert";
import { Contract, Event } from "ethers";
import winston from "winston";
import { isError } from "../../typeguards";
import {
  EventSearchConfig,
  MakeOptional,
  findLast,
  isArrayOf,
  isDefined,
  isPositiveInteger,
  max,
  paginatedEventQuery,
  sortEventsAscendingInPlace,
  sortEventsDescending,
  spreadEvent,
  spreadEventWithBlockNumber,
  toBN,
  utf8ToHex,
} from "../../utils";
import { PROTOCOL_DEFAULT_CHAIN_ID_INDICES } from "../../constants";
import {
  ConfigStoreVersionUpdate,
  DisabledChainsUpdate,
  GlobalConfigUpdate,
  ParsedTokenConfig,
  RouteRateModelUpdate,
  SpokePoolTargetBalance,
  SpokeTargetBalanceUpdate,
  TokenConfig,
  UBAConfigUpdates,
  UBAParsedConfigType,
} from "../../interfaces";
import { parseJSONWithNumericString } from "../../utils/JSONUtils";
import { BaseAbstractClient } from "../BaseAbstractClient";

type _ConfigStoreUpdate = {
  success: true;
  chainId: number;
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
  public cumulativeMaxRefundCountUpdates: GlobalConfigUpdate[] = [];
  public cumulativeMaxL1TokenCountUpdates: GlobalConfigUpdate[] = [];
  public chainIdIndicesUpdates: GlobalConfigUpdate<number[]>[] = [];
  public cumulativeSpokeTargetBalanceUpdates: SpokeTargetBalanceUpdate[] = [];
  public cumulativeConfigStoreVersionUpdates: ConfigStoreVersionUpdate[] = [];
  public cumulativeDisabledChainUpdates: DisabledChainsUpdate[] = [];

  protected rateModelDictionary: across.rateModel.RateModelDictionary;

  public hasLatestConfigStoreVersion = false;
  public chainId: number | undefined;

  constructor(
    readonly logger: winston.Logger,
    readonly configStore: Contract,
    readonly eventSearchConfig: MakeOptional<EventSearchConfig, "toBlock"> = { fromBlock: 0, maxBlockLookBack: 0 },
    readonly configStoreVersion: number
  ) {
    super();
    this.firstBlockToSearch = eventSearchConfig.fromBlock;
    this.latestBlockSearched = 0;
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

  /**
   * Resolve the implied set of chain ID indices based on the chain ID of the ConfigStore.
   * @param chainId Chain ID of the ConfigStore.
   * @dev If the resolved chain ID is part of the default set, assume the protocol defaults.
   *      Otherwise, assume this is a test deployment with a lone chain ID.
   * @dev The protocol defaults are [1, 10, 137, 288, 42161] (outlined in UMIP-157).
   * @dev chainId is marked optional to appease tsc. It must always be passed in.
   */
  protected implicitChainIdIndices(chainId?: number): number[] {
    assert(isDefined(chainId), "ConfigStoreClient used before update");
    return PROTOCOL_DEFAULT_CHAIN_ID_INDICES[0] === chainId ? PROTOCOL_DEFAULT_CHAIN_ID_INDICES : [chainId];
  }

  /**
   * Resolves the chain ids that were available to the protocol at a given block range.
   * @param blockNumber Block number to search for. Defaults to latest block.
   * @returns List of chain IDs that were available to the protocol at the given block number.
   * @note This dynamic functionality has been added after the launch of Across.
   * @note This function will return a default list of chain IDs if the block requested
   *       existed before the initial inclusion of this dynamic key/value entry. In the
   *       case that a block number is requested that is before the initial inclusion of
   *       this key/value entry, the function will return the default list of chain IDs as
   *       outlined per the UMIP (https://github.com/UMAprotocol/UMIPs/pull/590).
   */
  getChainIdIndicesForBlock(blockNumber: number = Number.MAX_SAFE_INTEGER): number[] {
    // Resolve the chain ID indices for the block number requested.
    const chainIdUpdates = sortEventsDescending(this.chainIdIndicesUpdates);
    // Iterate through each of the chain ID updates and resolve the first update that is
    // less than or equal to the block number requested.
    const chainIdIndices = chainIdUpdates.find((update) => update.blockNumber <= blockNumber)?.value;

    // Return either the found value or the protocol default.
    return chainIdIndices ?? this.implicitChainIdIndices(this.chainId);
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
   * @returns List of chain IDs that have been enabled at least once in the block range. Sorted from lowest to highest.
   */
  getEnabledChainsInBlockRange(fromBlock: number, toBlock = Number.MAX_SAFE_INTEGER): number[] {
    // If our fromBlock is greater than our toBlock, then we have an invalid range.
    if (fromBlock > toBlock) {
      throw new Error(`Invalid block range: fromBlock ${fromBlock} > toBlock ${toBlock}`);
    }

    // Initiate list with all possible chains enabled at the toBlock while removing any chains
    // that were disabled at the from block.
    const disabledChainsAtFromBlock = this.getDisabledChainsForBlock(fromBlock);
    const allPossibleChains = this.getChainIdIndicesForBlock(toBlock);
    const enabledChainsInBlockRange = allPossibleChains.filter(
      (chainId) => !disabledChainsAtFromBlock.includes(chainId)
    );

    // If there are any disabled chain updates in the block range, then we might need to update the list of enabled
    // chains in the block range.
    this.cumulativeDisabledChainUpdates
      .filter((e) => e.blockNumber <= toBlock && e.blockNumber >= fromBlock)
      .forEach((e) => {
        // If disabled chain update no longer includes a previously disabled chain, then add it back to the enabled chains
        // list.
        const newDisabledSet = e.chainIds;
        disabledChainsAtFromBlock.forEach((disabledChain) => {
          // New disabled set doesn't include this chain that was previously disabled so it was re-enabled at this point
          // in the block range.
          if (!newDisabledSet.includes(disabledChain)) {
            enabledChainsInBlockRange.push(disabledChain);
          }
        });
      });
    // Return the enabled chains in the block range sorted in the same order as the chain indices.
    return allPossibleChains.filter((chainId) => enabledChainsInBlockRange.includes(chainId));
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

  getConfigStoreVersionForBlock(blockNumber: number = Number.MAX_SAFE_INTEGER): number {
    const config = this.cumulativeConfigStoreVersionUpdates.find((config) => config.blockNumber <= blockNumber);
    return isDefined(config) ? Number(config.value) : DEFAULT_CONFIG_STORE_VERSION;
  }

  hasValidConfigStoreVersionForTimestamp(timestamp: number = Number.MAX_SAFE_INTEGER): boolean {
    const version = this.getConfigStoreVersionForTimestamp(timestamp);
    return this.configStoreVersion >= version;
  }

  /**
   * Resolve the chain ID for the ConfigStore Provider instance.
   * @dev When the provider is a StatisJsonRpcProvider instance, the getNetwork() is non-blocking.
   * @returns Chain ID for the ConfigStore deployment.
   */
  protected async resolveChainId(): Promise<number> {
    return this.chainId ?? (await this.configStore.provider.getNetwork()).chainId;
  }

  protected async _update(): Promise<ConfigStoreUpdate> {
    const chainId = await this.resolveChainId();

    const searchConfig = {
      fromBlock: this.firstBlockToSearch,
      toBlock: this.eventSearchConfig.toBlock || (await this.configStore.provider.getBlockNumber()),
      maxBlockLookBack: this.eventSearchConfig.maxBlockLookBack,
    };

    this.logger.debug({ at: "AcrossConfigStore", message: "Updating ConfigStore client", searchConfig });

    if (searchConfig.fromBlock > searchConfig.toBlock) {
      this.logger.warn({ at: "AcrossConfigStore", message: "Invalid search config.", searchConfig });
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
      chainId,
      searchEndBlock: searchConfig.toBlock,
      events: {
        updatedTokenConfigEvents,
        updatedGlobalConfigEvents,
        globalConfigUpdateTimes,
      },
    };
  }

  async update(): Promise<void> {
    const result = await this._update();
    if (!result.success) {
      return;
    }
    const { chainId } = result;
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

        // TODO: Temporarily reformat the shape of the event that we pass into the sdk.rateModel class to make it fit
        // the expected shape. This is a fix for now that we should eventually replace when we change the sdk.rateModel
        // class itself to work with the generalized ConfigStore.
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        const { value, key, ...passedArgs } = args;

        // Drop value and key before passing args.
        if (parsedValue?.rateModel !== undefined) {
          const rateModelForToken = JSON.stringify(parsedValue.rateModel);
          this.cumulativeRateModelUpdates.push({ ...passedArgs, rateModel: rateModelForToken, l1Token });

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
        if (result.searchEndBlock - event.blockNumber < maxWarnAge) {
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
        try {
          // We need to parse the chain ID indices array from the stringified JSON. However,
          // the on-chain string has quotes around the array, which will parse our JSON as a
          // string instead of an array. We need to remove these quotes before parsing.
          // To be sure, we can check for single quotes, double quotes, and spaces.
          const chainIndices = JSON.parse(args.value.replace(/['"\s]/g, ""));
          // Check that the array is valid and that every element is a number.
          if (!isArrayOf<number>(chainIndices, isPositiveInteger)) {
            this.logger.warn({ at: "ConfigStore", message: `The array ${chainIndices} is invalid.` });
            // If not a valid array, skip.
            continue;
          }
          // Let's also check that the array doesn't contain any duplicates.
          if (new Set(chainIndices).size !== chainIndices.length) {
            this.logger.warn({
              at: "ConfigStore",
              message: `The array ${chainIndices} contains duplicates making it invalid.`,
            });
            // If not a valid array, skip.
            continue;
          }
          // Now check that we're only appending positive integers to the chainIndices array on each
          // update. If this isn't the case, skip the update & warn. If there is no previous update,
          // resolve an implcit chain ID list.
          const previousUpdate = this.chainIdIndicesUpdates.at(-1)?.value ?? this.implicitChainIdIndices(chainId);
          // We should now check that previousUpdate is a subset of chainIndices.
          if (!previousUpdate.every((chainId, idx) => chainIndices[idx] === chainId)) {
            this.logger.warn({
              at: "ConfigStoreClient#update",
              message: `The array ${chainIndices} is invalid. It must be a superset of the previous array ${previousUpdate}`,
            });
            continue;
          }
          // If all else passes, we can add this update.
          this.chainIdIndicesUpdates.push({ ...args, value: chainIndices });
        } catch (e) {
          this.logger.warn({ at: "ConfigStore::update", message: `Failed to parse chain ID indices: ${args.value}` });
        }
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
    this.latestBlockSearched = result.searchEndBlock;
    this.firstBlockToSearch = result.searchEndBlock + 1; // Next iteration should start off from where this one ended.
    this.chainId = this.chainId ?? chainId; // Update on the first run only.
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
}
