import assert from "assert";
import { utils } from "@uma/sdk";
import { isError } from "../typeguards";
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
} from "../utils";
import { Contract, BigNumber, Event } from "ethers";
import winston from "winston";

import {
  L1TokenTransferThreshold,
  TokenConfig,
  GlobalConfigUpdate,
  ParsedTokenConfig,
  SpokeTargetBalanceUpdate,
  SpokePoolTargetBalance,
  RouteRateModelUpdate,
  ConfigStoreVersionUpdate,
  DisabledChainsUpdate,
} from "../interfaces";
import { across } from "@uma/sdk";
import { UBAFeeConfig } from "../UBAFeeCalculator";

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

export const GLOBAL_CONFIG_STORE_KEYS = {
  MAX_RELAYER_REPAYMENT_LEAF_SIZE: "MAX_RELAYER_REPAYMENT_LEAF_SIZE",
  MAX_POOL_REBALANCE_LEAF_SIZE: "MAX_POOL_REBALANCE_LEAF_SIZE",
  VERSION: "VERSION",
  DISABLED_CHAINS: "DISABLED_CHAINS",
};

export class AcrossConfigStoreClient {
  public cumulativeRateModelUpdates: across.rateModel.RateModelEvent[] = [];
  public cumulativeRouteRateModelUpdates: RouteRateModelUpdate[] = [];
  public cumulativeTokenTransferUpdates: L1TokenTransferThreshold[] = [];
  public cumulativeMaxRefundCountUpdates: GlobalConfigUpdate[] = [];
  public cumulativeMaxL1TokenCountUpdates: GlobalConfigUpdate[] = [];
  public cumulativeSpokeTargetBalanceUpdates: SpokeTargetBalanceUpdate[] = [];
  public cumulativeConfigStoreVersionUpdates: ConfigStoreVersionUpdate[] = [];
  public cumulativeDisabledChainUpdates: DisabledChainsUpdate[] = [];

  protected rateModelDictionary: across.rateModel.RateModelDictionary;
  public firstBlockToSearch: number;
  public latestBlockNumber = 0;

  public hasLatestConfigStoreVersion = false;

  public isUpdated = false;

  constructor(
    readonly logger: winston.Logger,
    readonly configStore: Contract,
    readonly eventSearchConfig: MakeOptional<EventSearchConfig, "toBlock"> = { fromBlock: 0, maxBlockLookBack: 0 },
    readonly configStoreVersion: number,
    readonly enabledChainIds: number[]
  ) {
    this.firstBlockToSearch = eventSearchConfig.fromBlock;
    this.rateModelDictionary = new across.rateModel.RateModelDictionary();
  }

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
  getEnabledChainsInBlockRange(
    fromBlock: number,
    toBlock = Number.MAX_SAFE_INTEGER,
    allPossibleChains = this.enabledChainIds
  ): number[] {
    if (toBlock < fromBlock) {
      throw new Error(`Invalid block range: fromBlock ${fromBlock} > toBlock ${toBlock}`);
    }
    // Initiate list with all chains enabled at the fromBlock.
    const disabledChainsAtFromBlock = this.getDisabledChainsForBlock(fromBlock);
    const enabledChainsAtFromBlock = allPossibleChains.filter(
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
        allPossibleChains.forEach((chainId) => {
          if (!disabledChainUpdate.chainIds.includes(chainId) && !enabledChains.includes(chainId)) {
            enabledChains.push(chainId);
          }
        });
        return enabledChains;
      }, enabledChainsAtFromBlock)
      .sort((a, b) => a - b);
  }

  getEnabledChains(block = Number.MAX_SAFE_INTEGER, allPossibleChains = this.enabledChainIds): number[] {
    // Get most recent disabled chain list before the block specified.
    const currentlyDisabledChains = this.getDisabledChainsForBlock(block);
    return allPossibleChains.filter((chainId) => !currentlyDisabledChains.includes(chainId));
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

  getConfigStoreVersionForBlock(blockNumber: number): number {
    const config = this.cumulativeConfigStoreVersionUpdates.find((config) => config.blockNumber <= blockNumber);
    return isDefined(config) ? Number(config.value) : DEFAULT_CONFIG_STORE_VERSION;
  }

  hasValidConfigStoreVersionForTimestamp(timestamp: number = Number.MAX_SAFE_INTEGER): boolean {
    const version = this.getConfigStoreVersionForTimestamp(timestamp);
    return this.isValidConfigStoreVersion(version);
  }

  isValidConfigStoreVersion(version: number): boolean {
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
        const parsedValue = JSON.parse(args.value) as ParsedTokenConfig;
        const rateModelForToken = JSON.stringify(parsedValue.rateModel);
        const transferThresholdForToken = parsedValue.transferThreshold;

        // If Token config doesn't contain all expected properties, skip it.
        if (!(rateModelForToken && transferThresholdForToken)) {
          throw new Error("Ignoring invalid rate model update");
        }

        // Store RateModel:
        // TODO: Temporarily reformat the shape of the event that we pass into the sdk.rateModel class to make it fit
        // the expected shape. This is a fix for now that we should eventually replace when we change the sdk.rateModel
        // class itself to work with the generalized ConfigStore.
        const l1Token = args.key;

        // Drop value and key before passing args.
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        const { value, key, ...passedArgs } = args;
        this.cumulativeRateModelUpdates.push({ ...passedArgs, rateModel: rateModelForToken, l1Token });

        // Store transferThreshold
        this.cumulativeTokenTransferUpdates.push({
          ...passedArgs,
          transferThreshold: toBN(transferThresholdForToken),
          l1Token,
        });

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

  async getUBATargetSpokeBalances(
    chainIds: number[],
    l1TokenAddress: string,
    blockNumber?: number
  ): Promise<{ spokeChainId: number; target: BigNumber }[]> {
    return chainIds.map((chainId) => {
      const target = this.getSpokeTargetBalancesForBlock(l1TokenAddress, chainId, blockNumber).target;
      return { spokeChainId: chainId, target };
    });
  }

  // THIS IS A STUB FOR NOW
  async getUBAFeeConfig(
    chainId: number,
    token: string,
    blockNumber: number | "latest" = "latest"
  ): Promise<UBAFeeConfig> {
    chainId;
    token;
    blockNumber;
    return new UBAFeeConfig(
      {
        default: toBN(0),
      },
      toBN(0),
      {
        default: [],
      },
      {},
      {
        default: [],
      }
    );
  }
}
