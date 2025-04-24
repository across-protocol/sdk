import { utils } from "@uma/sdk";
import assert from "assert";
import { Contract } from "ethers";
import winston from "winston";
import { isError } from "../../typeguards";
import {
  EventSearchConfig,
  MakeOptional,
  isArrayOf,
  isDefined,
  isPositiveInteger,
  max,
  paginatedEventQuery,
  sortEventsAscendingInPlace,
  sortEventsDescending,
  spreadEventWithBlockNumber,
  toBN,
  toWei,
  utf8ToHex,
} from "../../utils";
import { PROTOCOL_DEFAULT_CHAIN_ID_INDICES } from "../../constants";
import {
  ConfigStoreVersionUpdate,
  DisabledChainsUpdate,
  GlobalConfigUpdate,
  LiteChainsIdListUpdate,
  Log,
  ParsedTokenConfig,
  RateModelUpdate,
  RouteRateModelUpdate,
  SortableEvent,
  SpokePoolTargetBalance,
  SpokeTargetBalanceUpdate,
  TokenConfig,
} from "../../interfaces";
import { parseJSONWithNumericString } from "../../utils/JSONUtils";
import { BaseAbstractClient, isUpdateFailureReason, UpdateFailureReason } from "../BaseAbstractClient";
import { parseAndReturnRateModelFromString } from "../../lpFeeCalculator/rateModel";
import { RateModel } from "../../lpFeeCalculator";

type ConfigStoreUpdateSuccess = {
  success: true;
  chainId: number;
  searchEndBlock: number;
  events: {
    updatedTokenConfigEvents: Log[];
    updatedGlobalConfigEvents: Log[];
    globalConfigUpdateTimes: number[];
  };
};
type ConfigStoreUpdateFailure = { success: false; reason: UpdateFailureReason };
export type ConfigStoreUpdate = ConfigStoreUpdateSuccess | ConfigStoreUpdateFailure;

// Version 0 is the implicit ConfigStore version from before the version attribute was introduced.
// @dev Do not change this value.
export const DEFAULT_CONFIG_STORE_VERSION = 0;

export enum GLOBAL_CONFIG_STORE_KEYS {
  MAX_RELAYER_REPAYMENT_LEAF_SIZE = "MAX_RELAYER_REPAYMENT_LEAF_SIZE",
  MAX_POOL_REBALANCE_LEAF_SIZE = "MAX_POOL_REBALANCE_LEAF_SIZE",
  VERSION = "VERSION",
  DISABLED_CHAINS = "DISABLED_CHAINS",
  CHAIN_ID_INDICES = "CHAIN_ID_INDICES",
  LITE_CHAIN_ID_INDICES = "LITE_CHAIN_ID_INDICES",
}

// Conveniently store known invalid token config update hashes to avoid spamming debug logs.
const KNOWN_INVALID_TOKEN_CONFIG_UPDATE_HASHES = [
  "0x422abc617c6598e4b91859f99c392939d2034c1a839a342a963a34a2f0390195",
  "0x36c85e388279714b2c98d46e3377dc37a1575665b2cac5e52fe97d8d77efcd2b",
  "0x6f0a93119e538dd84e02adfce821fb4e6dd9baddcceb041977e8ba3c39185ab8",
  "0xc28d8bb445e0b747201e6f98ee62aa03009f4c04b8d6f9fad8f214ec1166463d",
  "0x3b0719ef1e3cae2dc1a854a1012332a288e50ad24adc52861d42bcc30fd3deaf",
  "0xbae5c792f74d9f0b6554acf793df0d6b3610868bd6f6a377371b9dec10038003",
  "0xd983142980ac2451e913b152413e769f7a7007fe7305c2e8a03db432e892f84c",
  "0xf64610347950488503428fd720132f8188aa26dcc48e3fc9a89b7bc24aa7fda2",
  "0x1970fcd1e5d5d6cf3bbb640d30d5e471ce5161d65580cedb388526a32b2f7638",
  "0xf098c547d726be8fda419faaee1850280ded1ea75a1b10f4a1614805fa4207d3",
  "0xbfa181663761a78c66dd2c7012604eb910c4c39bad17089e2cc4a011ccc0e981",
  "0x89830f5e81b9e8b44ac2f8966b2fa4bf8e71d7f546e2bc0e773d8ee8df4bdb36",
  "0xb0ad6270124c925a234d9c4f87b60396f2b52fdc250cd2fc9cac792d0d62e467",
  "0x779bc3bf2dba1128d5dda6be8ae99b503cae23343a7265a86bca3d5572ed4268",
].map((hash) => hash.toLowerCase());

export class AcrossConfigStoreClient extends BaseAbstractClient {
  public cumulativeRateModelUpdates: RateModelUpdate[] = [];
  public cumulativeRouteRateModelUpdates: RouteRateModelUpdate[] = [];
  public cumulativeMaxRefundCountUpdates: GlobalConfigUpdate[] = [];
  public cumulativeMaxL1TokenCountUpdates: GlobalConfigUpdate[] = [];
  public chainIdIndicesUpdates: GlobalConfigUpdate<number[]>[] = [];
  public liteChainIndicesUpdates: LiteChainsIdListUpdate[] = [];
  public cumulativeSpokeTargetBalanceUpdates: SpokeTargetBalanceUpdate[] = [];
  public cumulativeConfigStoreVersionUpdates: ConfigStoreVersionUpdate[] = [];
  public cumulativeDisabledChainUpdates: DisabledChainsUpdate[] = [];

  public hasLatestConfigStoreVersion = false;
  public chainId: number | undefined;

  constructor(
    readonly logger: winston.Logger,
    readonly configStore: Contract,
    eventSearchConfig: MakeOptional<EventSearchConfig, "toBlock"> = { fromBlock: 0, maxBlockLookBack: 0 },
    readonly configStoreVersion: number
  ) {
    super(eventSearchConfig);
    this.firstBlockToSearch = eventSearchConfig.fromBlock;
    this.latestBlockSearched = 0;
  }

  getRateModelForBlockNumber(
    l1Token: string,
    originChainId: number | string,
    destinationChainId: number | string,
    blockNumber: number | undefined = undefined
  ): RateModel {
    // Use route-rate model if available, otherwise use default rate model for l1Token.
    const route = `${originChainId}-${destinationChainId}`;
    const routeRateModel = this.getRouteRateModelForBlockNumber(l1Token, route, blockNumber);
    if (routeRateModel) {
      return routeRateModel;
    }

    const defaultRateModelUpdate = sortEventsDescending(this.cumulativeRateModelUpdates).find(
      (config) =>
        config.blockNumber <= (blockNumber ?? 0) && config.l1Token === l1Token && config.rateModel !== undefined
    );
    if (!defaultRateModelUpdate) {
      throw new Error(`Could not find TokenConfig update for ${l1Token} at block ${blockNumber}`);
    }
    return parseAndReturnRateModelFromString(defaultRateModelUpdate.rateModel);
  }

  getRouteRateModelForBlockNumber(
    l1Token: string,
    route: string,
    blockNumber: number | undefined = undefined
  ): RateModel | undefined {
    const config = (sortEventsDescending(this.cumulativeRouteRateModelUpdates) as RouteRateModelUpdate[]).find(
      (config) => config.blockNumber <= (blockNumber ?? 0) && config.l1Token === l1Token
    );
    if (config?.routeRateModel[route] === undefined) {
      return undefined;
    }
    return parseAndReturnRateModelFromString(config.routeRateModel[route]);
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

  /**
   * Resolves the lite chain ids that were available to the protocol at a given block range.
   * @param blockNumber Block number to search for. Defaults to latest block.
   * @returns List of lite chain IDs that were available to the protocol at the given block number.
   * @note This dynamic functionality has been added after the launch of Across.
   */
  getLiteChainIdIndicesForBlock(blockNumber: number = Number.MAX_SAFE_INTEGER): number[] {
    const liteChainIdList = sortEventsDescending(this.liteChainIndicesUpdates);
    return liteChainIdList.find((update) => update.blockNumber <= blockNumber)?.value ?? [];
  }

  /**
   * Resolves the lite chain ids that were available to the protocol at a given timestamp.
   * @param timestamp Timestamp to search for. Defaults to latest time - in seconds.
   * @returns List of lite chain IDs that were available to the protocol at the given timestamp.
   * @note This dynamic functionality has been added after the launch of Across.
   */
  getLiteChainIdIndicesForTimestamp(timestamp: number = Number.MAX_SAFE_INTEGER): number[] {
    const liteChainIdList = sortEventsDescending(this.liteChainIndicesUpdates);
    return liteChainIdList.find((update) => update.timestamp <= timestamp)?.value ?? [];
  }

  /**
   * Checks if a chain ID was a lite chain at a given timestamp.
   * @param chainId The chain ID to check.
   * @param timestamp The timestamp to check. Defaults to latest time - in seconds.
   * @returns True if the chain ID was a lite chain at the given timestamp. False otherwise.
   */
  isChainLiteChainAtTimestamp(chainId: number, timestamp: number = Number.MAX_SAFE_INTEGER): boolean {
    return this.getLiteChainIdIndicesForTimestamp(timestamp).includes(chainId);
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

    const searchConfig = await this.updateSearchConfig(this.configStore.provider);
    if (isUpdateFailureReason(searchConfig)) {
      const reason = searchConfig;
      return { success: false, reason };
    }

    this.logger.debug({ at: "AcrossConfigStore", message: "Updating ConfigStore client", searchConfig });

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
      if (result.reason !== UpdateFailureReason.AlreadyUpdated) {
        throw new Error(`Unable to update ConfigStoreClient: ${result.reason}`);
      }

      // No need to touch `this.isUpdated` because it should already be set from a previous update.
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
      // If transaction hash is known to be invalid, skip it immediately to avoid creating extra logs.
      if (KNOWN_INVALID_TOKEN_CONFIG_UPDATE_HASHES.includes(event.transactionHash.toLowerCase())) {
        continue;
      }

      const args = {
        ...(spreadEventWithBlockNumber(event) as TokenConfig),
      };

      try {
        const { rateModel, routeRateModel, spokeTargetBalances } = this.validateTokenConfigUpdate(args);
        const { value, key: l1Token, ...eventData } = args;

        if (rateModel !== undefined) {
          this.cumulativeRateModelUpdates.push({ ...eventData, rateModel, l1Token });
          this.cumulativeSpokeTargetBalanceUpdates.push({
            ...eventData,
            spokeTargetBalances,
            l1Token,
          });
          this.cumulativeRouteRateModelUpdates.push({ ...eventData, routeRateModel, l1Token });
        }
      } catch (err) {
        // @dev averageBlockTimeSeconds does not actually block.
        const maxWarnAge = (24 * 60 * 60) / (await utils.averageBlockTimeSeconds());
        if (result.searchEndBlock - event.blockNumber < maxWarnAge) {
          const errMsg = isError(err) ? err.message : "unknown error";
          // This will emit warning logs for any invalid historical updates and it will be very noisy, so
          // developer should move over known invalid hashes to KNOWN_INVALID_TOKEN_CONFIG_UPDATE_HASHES to
          // suppress these warnings.
          this.logger.warn({
            at: "ConfigStore::update",
            message: `Caught error during ConfigStore update: ${errMsg}`,
            update: args,
          });
        } else {
          this.logger.debug({
            at: "ConfigStoreClient::update",
            message: `Skipping invalid historical update at block ${event.blockNumber}`,
            transactionHash: event.transactionHash,
          });
        }
        continue;
      }
    }

    // Save new Global config updates.
    for (let i = 0; i < updatedGlobalConfigEvents.length; i++) {
      const args = spreadEventWithBlockNumber(updatedGlobalConfigEvents[i]) as SortableEvent & {
        key: string;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        value: any;
      };

      if (args.key === utf8ToHex(GLOBAL_CONFIG_STORE_KEYS.MAX_RELAYER_REPAYMENT_LEAF_SIZE)) {
        if (!isNaN(args.value)) {
          this.cumulativeMaxRefundCountUpdates.push(args);
        }
      } else if (args.key === utf8ToHex(GLOBAL_CONFIG_STORE_KEYS.LITE_CHAIN_ID_INDICES)) {
        // We need to parse the chain ID indices array from the stringified JSON. However,
        // the on-chain string has quotes around the array, which will parse our JSON as a
        // string instead of an array. We need to remove these quotes before parsing.
        // To be sure, we can check for single quotes, double quotes, and spaces.

        // Use a regular expression to check if the string is a valid array. We need to check for
        // leading and trailing quotes, as well as leading and trailing whitespace. We also need to
        // check for commas between the numbers. Alternatively, this can be an empty array.
        if (!/^\s*["']?\[(\d+(,\d+)*)?\]["']?\s*$/.test(args.value)) {
          this.logger.warn({ at: "ConfigStore", message: `The lite chain indices array ${args.value} is invalid.` });
          // If not a valid array, skip.
          continue;
        }
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
        // If all else passes, we can add this update.
        this.liteChainIndicesUpdates.push({ ...args, value: chainIndices, timestamp: globalConfigUpdateTimes[i] });
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

    this.hasLatestConfigStoreVersion = this.hasValidConfigStoreVersionForTimestamp();
    this.latestBlockSearched = result.searchEndBlock;
    this.firstBlockToSearch = result.searchEndBlock + 1; // Next iteration should start off from where this one ended.
    this.eventSearchConfig.toBlock = undefined; // Caller can re-set on subsequent updates if necessary
    this.chainId = this.chainId ?? chainId; // Update on the first run only.
    this.isUpdated = true;

    this.logger.debug({ at: "ConfigStore", message: "ConfigStore client updated!" });
  }

  validateTokenConfigUpdate(args: TokenConfig): {
    spokeTargetBalances: SpokeTargetBalanceUpdate["spokeTargetBalances"];
    rateModel: string | undefined;
    routeRateModel: RouteRateModelUpdate["routeRateModel"];
  } {
    const { value, key, transactionHash } = args;
    const parsedValue = parseJSONWithNumericString(value) as ParsedTokenConfig;
    const l1Token = key;

    // Return the following parameters if the TokenConfig update is valid, otherwise throw an error.
    // Remove any config updates with invalid rate models by throwing an error if any part of the TokenConfig
    // is wrong before we push any events into this client's state.
    let rateModelForToken: string | undefined = undefined;
    let spokeTargetBalances: SpokeTargetBalanceUpdate["spokeTargetBalances"] = {};
    let routeRateModel: RouteRateModelUpdate["routeRateModel"] = {};

    // Drop value and key before passing args.
    if (parsedValue?.rateModel !== undefined) {
      const rateModel = parsedValue.rateModel;
      assert(
        this.isValidRateModel(rateModel),
        `Invalid rateModel UBar for ${l1Token} at transaction ${transactionHash}, ${JSON.stringify(rateModel)}`
      );
      rateModelForToken = JSON.stringify(rateModel);

      // Store spokeTargetBalances
      if (parsedValue?.spokeTargetBalances) {
        // Note: cast is required because fromEntries always produces string keys, despite the function returning a
        // numerical key.
        spokeTargetBalances = Object.fromEntries(
          Object.entries(parsedValue.spokeTargetBalances).map(([chainId, targetBalance]) => {
            const target = max(toBN(targetBalance.target), toBN(0));
            const threshold = max(toBN(targetBalance.threshold), toBN(0));
            return [chainId, { target, threshold }];
          })
        ) as SpokeTargetBalanceUpdate["spokeTargetBalances"];
      }

      // Store route-specific rate models
      if (parsedValue?.routeRateModel) {
        routeRateModel = Object.fromEntries(
          Object.entries(parsedValue.routeRateModel).map(([path, routeRateModel]) => {
            assert(
              this.isValidRateModel(routeRateModel) &&
                `Invalid routeRateModel UBar for ${path} for ${l1Token} at transaction ${transactionHash}, ${JSON.stringify(
                  routeRateModel
                )}`
            );
            return [path, JSON.stringify(routeRateModel)];
          })
        );
      }
    }

    return {
      spokeTargetBalances,
      rateModel: rateModelForToken,
      routeRateModel,
    };
  }

  isValidRateModel(rateModel: RateModel): boolean {
    // UBar should be between 0% and 100%.
    return toBN(rateModel.UBar).gt(0) && toBN(rateModel.UBar).lt(toWei("1"));
  }

  filterDisabledChains(disabledChains: number[]): number[] {
    // If any chain ID's are not integers then ignore. UMIP-157 requires that this key cannot include
    // the chain ID 1.
    return disabledChains.filter((chainId: number) => !isNaN(chainId) && Number.isInteger(chainId) && chainId !== 1);
  }
}
