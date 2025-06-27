import assert from "assert";
import { Transport } from "viem";
import {
  DEFAULT_SIMULATED_RELAYER_ADDRESS,
  DEFAULT_SIMULATED_RELAYER_ADDRESS_SVM,
  TOKEN_SYMBOLS_MAP,
} from "../constants";
import { Deposit } from "../interfaces";
import {
  BigNumber,
  BigNumberish,
  MAX_BIG_INT,
  TransactionCostEstimate,
  bnZero,
  fixedPointAdjustment,
  getTokenInfo,
  isDefined,
  isZeroAddress,
  max,
  min,
  nativeToToken,
  percent,
  toBN,
  toBNWei,
  compareAddressesSimple,
  ConvertDecimals,
  chainIsSvm,
  toAddressType,
  Address,
} from "../utils";

// This needs to be implemented for every chain and passed into RelayFeeCalculator
export interface QueryInterface {
  getGasCosts: (
    deposit: Omit<Deposit, "messageHash">,
    relayer: Address,
    options?: Partial<{
      gasPrice: BigNumberish;
      gasUnits: BigNumberish;
      baseFeeMultiplier: BigNumber;
      priorityFeeMultiplier: BigNumber;
      opStackL1GasCostMultiplier: BigNumber;
      transport: Transport;
    }>
  ) => Promise<TransactionCostEstimate>;
  getTokenPrice: (tokenSymbol: string) => Promise<number>;
  getNativeGasCost: (deposit: Omit<Deposit, "messageHash">, relayer: Address) => Promise<BigNumber>;
}

export const expectedCapitalCostsKeys = ["lowerBound", "upperBound", "cutoff", "decimals"];
export interface CapitalCostConfig {
  lowerBound: string;
  upperBound: string;
  cutoff: string;
  decimals: number;
}
type ChainIdAsString = string;
export interface CapitalCostConfigOverride {
  default: CapitalCostConfig;
  routeOverrides?: Record<ChainIdAsString, Record<ChainIdAsString, CapitalCostConfig>>;
  destinationChainOverrides?: Record<ChainIdAsString, CapitalCostConfig>;
  originChainOverrides?: Record<ChainIdAsString, CapitalCostConfig>;
}
export type RelayCapitalCostConfig = CapitalCostConfigOverride | CapitalCostConfig;
export interface BaseRelayFeeCalculatorConfig {
  nativeTokenDecimals?: number;
  gasDiscountPercent?: number;
  capitalDiscountPercent?: number;
  feeLimitPercent?: number;
  capitalCostsConfig: {
    [token: string]: CapitalCostConfig | CapitalCostConfigOverride;
  };
}
export interface RelayFeeCalculatorConfigWithQueries extends BaseRelayFeeCalculatorConfig {
  queries: QueryInterface;
}
export interface RelayFeeCalculatorConfigWithMap extends BaseRelayFeeCalculatorConfig {
  queriesMap: Record<number, QueryInterface>;
}
export type RelayFeeCalculatorConfig = RelayFeeCalculatorConfigWithQueries | RelayFeeCalculatorConfigWithMap;

export interface RelayerFeeDetails {
  amountToRelay: string;
  tokenSymbol: string;
  gasFeePercent: string;
  gasFeeTotal: string;
  gasDiscountPercent: number;
  capitalFeePercent: string;
  capitalFeeTotal: string;
  capitalDiscountPercent: number;
  relayFeePercent: string;
  relayFeeTotal: string;
  feeLimitPercent: number;
  isAmountTooLow: boolean;
  maxGasFeePercent: string;
  minDeposit: string;
}

export interface LoggingFunction {
  (data: { at: string; message: string; [key: string]: unknown }): void;
}

export interface Logger {
  debug: LoggingFunction;
  info: LoggingFunction;
  warn: LoggingFunction;
  error: LoggingFunction;
}

export const DEFAULT_LOGGER: Logger = {
  debug: (...args) => console.debug(args),
  info: (...args) => console.info(args),
  warn: (...args) => console.warn(args),
  error: (...args) => console.error(args),
};

export function getDefaultRelayer(chainId?: number) {
  return isDefined(chainId) && chainIsSvm(chainId)
    ? DEFAULT_SIMULATED_RELAYER_ADDRESS_SVM
    : DEFAULT_SIMULATED_RELAYER_ADDRESS;
}

// Small amount to simulate filling with. Should be low enough to guarantee a successful fill.
const safeOutputAmount = toBN(100);

export class RelayFeeCalculator {
  private queries: QueryInterface;
  private gasDiscountPercent: Required<RelayFeeCalculatorConfig>["gasDiscountPercent"];
  private capitalDiscountPercent: Required<RelayFeeCalculatorConfig>["capitalDiscountPercent"];
  private feeLimitPercent: Required<RelayFeeCalculatorConfig>["feeLimitPercent"];
  private nativeTokenDecimals: Required<RelayFeeCalculatorConfig>["nativeTokenDecimals"];
  private capitalCostsConfig: { [token: string]: CapitalCostConfigOverride };

  // For logging if set. This function should accept 2 args - severity (INFO, WARN, ERROR) and the logs data, which will
  // be an object.
  private logger: Logger;

  constructor(config: RelayFeeCalculatorConfigWithQueries, logger?: Logger);
  constructor(config: RelayFeeCalculatorConfigWithMap, logger?: Logger, destinationChainId?: number);
  constructor(config?: RelayFeeCalculatorConfig, logger?: Logger, destinationChainId?: number) {
    assert(config, "config must be provided");

    if ("queries" in config) {
      this.queries = config.queries;
    } else {
      assert(destinationChainId !== undefined, "destinationChainId must be provided if queriesMap is provided");
      assert(config.queriesMap[destinationChainId], "No queries provided for destination chain");
      this.queries = config.queriesMap[destinationChainId];
    }

    this.gasDiscountPercent = config.gasDiscountPercent || 0;
    this.capitalDiscountPercent = config.capitalDiscountPercent || 0;
    this.feeLimitPercent = config.feeLimitPercent || 0;
    this.nativeTokenDecimals = config.nativeTokenDecimals || 18;
    assert(
      this.gasDiscountPercent >= 0 && this.gasDiscountPercent <= 100,
      "gasDiscountPercent must be between 0 and 100 percent"
    );
    assert(
      this.capitalDiscountPercent >= 0 && this.capitalDiscountPercent <= 100,
      "capitalDiscountPercent must be between 0 and 100 percent"
    );
    assert(
      this.feeLimitPercent >= 0 && this.feeLimitPercent <= 100,
      "feeLimitPercent must be between 0 and 100 percent"
    );
    this.capitalCostsConfig = Object.fromEntries(
      Object.entries(config.capitalCostsConfig).map(([token, capitalCosts]) => {
        return [token.toUpperCase(), RelayFeeCalculator.validateAndTransformCapitalCostsConfigOverride(capitalCosts)];
      })
    );
    assert(Object.keys(this.capitalCostsConfig).length > 0, "capitalCostsConfig must have at least one entry");
    this.logger = logger || DEFAULT_LOGGER;
    // warn developer of any possible conflicting config overrides
    this.checkAllConfigConflicts();
  }

  /**
   * Type guard to check if a config is a CapitalCostConfigOverride or a CapitalCostConfig.
   * @param config CapitalCostConfig or CapitalCostConfigOverride
   * @returns true if the config is a CapitalCostConfigOverride, false otherwise.
   * @private
   * @dev This is a type guard that is used to check if a config is a CapitalCostConfigOverride or a CapitalCostConfig.
   * This is needed because the config can be either a CapitalCostConfig or a CapitalCostConfigOverride. If it's a
   * CapitalCostConfig, then we need to convert it to a CapitalCostConfigOverride with the default config set with no route
   * overrides.
   */
  private static capitalCostConfigIsOverride(
    config: CapitalCostConfig | CapitalCostConfigOverride
  ): config is CapitalCostConfigOverride {
    return (config as CapitalCostConfigOverride).default !== undefined;
  }

  /**
   * Validates a CapitalCostConfigOverride or a CapitalCostConfig.
   * @param capitalCosts CapitalCostConfig or CapitalCostConfigOverride
   * @returns CapitalCostConfigOverride
   */
  static validateAndTransformCapitalCostsConfigOverride(
    capitalCosts: CapitalCostConfigOverride | CapitalCostConfig
  ): CapitalCostConfigOverride {
    // We need to first convert the config to a baseline type. This is because the config can be either a CapitalCostConfig
    // or a CapitalCostConfigOverride. If it's a CapitalCostConfig, then we need to convert it to a CapitalCostConfigOverride with
    // the default config set with no route overrides.
    const config: CapitalCostConfigOverride = this.capitalCostConfigIsOverride(capitalCosts)
      ? capitalCosts
      : { default: capitalCosts };

    // Validate the default config.
    this.validateCapitalCostsConfig(config.default);
    // Iterate over all the route overrides and validate them.
    for (const toChainIdRoutes of Object.values(config.routeOverrides || {})) {
      Object.values(toChainIdRoutes).forEach(this.validateCapitalCostsConfig);
    }
    // Validate origin chain overrides
    Object.values(config.originChainOverrides || {}).forEach(this.validateCapitalCostsConfig);
    // Validate destination chain overrides
    Object.values(config.destinationChainOverrides || {}).forEach(this.validateCapitalCostsConfig);

    return config;
  }

  /**
   * Validates a CapitalCostConfig.
   * @param capitalCosts CapitalCostConfig
   */
  static validateCapitalCostsConfig(capitalCosts: CapitalCostConfig): void {
    assert(toBN(capitalCosts.upperBound).lt(toBNWei("1")), "upper bound must be < 100%");
    assert(capitalCosts.decimals > 0 && capitalCosts.decimals <= 18, "invalid decimals");
  }

  getTokenPrice(tokenSymbol: string): Promise<number> {
    return this.queries.getTokenPrice(tokenSymbol);
  }

  /**
   * Calculate the gas fee as a % of the amount to relay.
   * @param deposit A valid deposit object to reason about
   * @param amountToRelay The amount that we should fill the deposit for
   * @param simulateZeroFill Whether to simulate a zero fill for the gas cost simulation
   *        A fill of 1 wei which would result in a slow/partial fill.
   *        You should do this if you're not worried about simulating a proper fill of a deposit
   *        with a message or if you are worried a fill amount that could exceed the balance of
   *        the relayer.
   * @param relayerAddress The relayer that will be used for the gas cost simulation
   * @param _tokenPrice The token price for normalizing fees
   * @returns The fee as a % of the amount to relay.
   * @note Setting simulateZeroFill to true will result on the gas costs being estimated
   *       on a zero fill. However, the percentage will be returned as a percentage of the
   *       amount to relay. This is useful for determining the maximum gas fee % that a
   *       relayer may need to make on a regular fill. You will get differing results if
   *       a message & recipient contract is provided as this function may not simulate with
   *       the correct parameters to see a full fill.
   */
  async gasFeePercent(
    deposit: Deposit,
    outputAmount: BigNumberish,
    simulateZeroFill = false,
    relayerAddress = toAddressType(getDefaultRelayer(deposit.destinationChainId), deposit.destinationChainId),
    _tokenPrice?: number,
    tokenMapping = TOKEN_SYMBOLS_MAP,
    gasPrice?: BigNumberish,
    gasLimit?: BigNumberish,
    _tokenGasCost?: BigNumberish,
    transport?: Transport
  ): Promise<BigNumber> {
    if (toBN(outputAmount).eq(bnZero)) return MAX_BIG_INT;

    const { inputToken, destinationChainId, originChainId } = deposit;
    // It's fine if we resolve a destination token which is not the "canonical" L1 token (e.g. USDB for DAI or USDC.e for USDC), since `getTokenInfo` will re-map
    // the output token to the canonical version. What matters here is that we find an entry in the token map which has defined addresses for BOTH the origin
    // and destination chain. This prevents the call to `getTokenInfo` to mistakenly return token info for a token which has a defined address on origin and an
    // undefined address on destination.
    const destinationChainTokenDetails = Object.values(tokenMapping).find(
      (details) =>
        compareAddressesSimple(details.addresses[originChainId], inputToken.toNative()) &&
        isDefined(details.addresses[destinationChainId])
    );
    const outputToken = isZeroAddress(deposit.outputToken)
      ? destinationChainTokenDetails!.addresses[destinationChainId]
      : deposit.outputToken.toNative();
    const outputTokenInfo = getTokenInfo(outputToken, destinationChainId, tokenMapping);
    const inputTokenInfo = getTokenInfo(inputToken.toNative(), originChainId, tokenMapping);
    if (!isDefined(outputTokenInfo) || !isDefined(inputTokenInfo)) {
      throw new Error(`Could not find token information for ${inputToken} or ${outputToken}`);
    }

    // Reduce the output amount to simulate a full fill with a lower value to estimate
    // the fill cost accurately without risking a failure due to insufficient balance.
    const simulatedAmount = simulateZeroFill ? safeOutputAmount : toBN(outputAmount);
    deposit = { ...deposit, outputAmount: simulatedAmount };

    const getGasCosts = this.queries
      .getGasCosts(deposit, relayerAddress, { gasPrice, gasUnits: gasLimit, transport })
      .then(({ tokenGasCost }) => tokenGasCost)
      .catch((error) => {
        this.logger.error({
          at: "sdk/gasFeePercent",
          message: "Error while fetching gas costs",
          error,
          simulateZeroFill,
          deposit,
        });
        throw error;
      });
    const [tokenGasCost, tokenPrice] = await Promise.all([
      _tokenGasCost ? Promise.resolve(_tokenGasCost) : getGasCosts,
      _tokenPrice ??
        this.queries.getTokenPrice(outputTokenInfo.symbol).catch((error) => {
          this.logger.error({
            at: "sdk/gasFeePercent",
            message: "Error while fetching token price",
            error,
            destinationChainId: deposit.destinationChainId,
            inputToken,
          });
          throw error;
        }),
    ]);
    const gasFeesInToken = nativeToToken(tokenGasCost, tokenPrice, outputTokenInfo.decimals, this.nativeTokenDecimals);
    return percent(gasFeesInToken, outputAmount.toString());
  }

  // Note: these variables are unused now, but may be needed in future versions of this function that are more complex.
  capitalFeePercent(
    _outputAmount: BigNumberish,
    _tokenSymbol: string,
    _originRoute?: ChainIdAsString,
    _destinationRoute?: ChainIdAsString
  ): BigNumber {
    // If amount is 0, then the capital fee % should be the max 100%
    if (toBN(_outputAmount).eq(toBN(0))) return MAX_BIG_INT;

    // V0: Ensure that there is a capital fee available for the token.
    // If not, then we should throw an error because this is indicative
    // of a misconfiguration.
    const tokenCostConfig = this.capitalCostsConfig[_tokenSymbol.toUpperCase()];
    if (!isDefined(tokenCostConfig)) {
      this.logger.error({
        at: "sdk/capitalFeePercent",
        message: `No capital fee available for token ${_tokenSymbol}`,
      });
      throw new Error(`No capital cost config available for token ${_tokenSymbol}`);
    }
    // V1: Charge fee that scales with size. This will charge a fee % based on a linear fee curve with a "kink" at a
    // cutoff in the same units as _amountToRelay. Before the kink, the fee % will increase linearly from a lower
    // bound to an upper bound. After the kink, the fee % increase will be fixed, and slowly approach the upper bound
    // for very large amount inputs.
    else {
      // Order of specificity (most specific to least specific):
      // 1. Route overrides (both origin and destination)
      // 2. Destination chain overrides
      // 3. Origin chain overrides
      // 4. Default config
      const routeOverride = tokenCostConfig?.routeOverrides?.[_originRoute || ""]?.[_destinationRoute || ""];
      const destinationChainOverride = tokenCostConfig?.destinationChainOverrides?.[_destinationRoute || ""];
      const originChainOverride = tokenCostConfig?.originChainOverrides?.[_originRoute || ""];
      const config: CapitalCostConfig =
        routeOverride ?? destinationChainOverride ?? originChainOverride ?? tokenCostConfig.default;

      // Check and log warnings for configuration conflicts
      this.warnIfConfigConflicts(
        _tokenSymbol,
        _originRoute || "",
        _destinationRoute || "",
        routeOverride,
        destinationChainOverride,
        originChainOverride
      );

      // Scale amount "y" to 18 decimals.
      const y = toBN(_outputAmount).mul(toBNWei("1", 18 - config.decimals));
      // At a minimum, the fee will be equal to lower bound fee * y
      const minCharge = toBN(config.lowerBound).mul(y).div(fixedPointAdjustment);

      // Charge an increasing marginal fee % up to min(cutoff, y). If y is very close to the cutoff, the fee %
      // will be equal to half the sum of (upper bound + lower bound).
      const yTriangle = min(config.cutoff, y);

      // triangleSlope is slope of fee curve from lower bound to upper bound. If cutoff is 0, slope is 0.
      // triangleCharge is interval of curve from 0 to y for curve = triangleSlope * y
      const triangleSlope = toBN(config.cutoff).eq(toBN(0))
        ? toBN(0)
        : toBN(config.upperBound).sub(config.lowerBound).mul(fixedPointAdjustment).div(config.cutoff);
      const triangleHeight = triangleSlope.mul(yTriangle).div(fixedPointAdjustment);
      const triangleCharge = triangleHeight.mul(yTriangle).div(toBNWei(2));

      // For any amounts above the cutoff, the marginal fee % will not increase but will be fixed at the upper bound
      // value.
      const yRemainder = max(toBN(0), y.sub(config.cutoff));
      const remainderCharge = yRemainder.mul(toBN(config.upperBound).sub(config.lowerBound)).div(fixedPointAdjustment);

      return minCharge.add(triangleCharge).add(remainderCharge).mul(fixedPointAdjustment).div(y);
    }
  }

  /**
   * Checks for configuration conflicts across all token symbols and their associated chain configurations.
   * This method examines the capital costs configuration for each token and identifies any overlapping
   * or conflicting configurations between route overrides, destination chain overrides, and origin chain overrides.
   * If conflicts are found, warnings will be logged via the warnIfConfigConflicts method.
   */
  private checkAllConfigConflicts(): void {
    for (const [tokenSymbol, tokenConfig] of Object.entries(this.capitalCostsConfig)) {
      // Get all origin chains that have specific configurations
      const originChains = new Set<string>(Object.keys(tokenConfig.originChainOverrides || {}));
      // Get all destination chains that have specific configurations
      const destChains = new Set<string>(Object.keys(tokenConfig.destinationChainOverrides || {}));

      // Add all chains from route overrides
      if (tokenConfig.routeOverrides) {
        Object.keys(tokenConfig.routeOverrides).forEach((originChain) => {
          originChains.add(originChain);
          Object.keys(tokenConfig.routeOverrides![originChain]).forEach((destChain) => {
            destChains.add(destChain);
          });
        });
      }

      // If there are no specific chain configurations, just check the default case
      if (originChains.size === 0 && destChains.size === 0) {
        continue;
      }

      // Check for conflicts between all combinations of origin and destination chains
      for (const originChain of Array.from(originChains)) {
        for (const destChain of Array.from(destChains)) {
          const routeOverride = tokenConfig.routeOverrides?.[originChain]?.[destChain];
          const destinationChainOverride = tokenConfig.destinationChainOverrides?.[destChain];
          const originChainOverride = tokenConfig.originChainOverrides?.[originChain];

          this.warnIfConfigConflicts(
            tokenSymbol,
            originChain,
            destChain,
            routeOverride,
            destinationChainOverride,
            originChainOverride
          );
        }
      }
    }
  }

  /**
   * Log a warning if multiple configuration types apply to the same route
   * @private
   */
  private warnIfConfigConflicts(
    tokenSymbol: string,
    originChain: string,
    destChain: string,
    routeOverride?: CapitalCostConfig,
    destinationChainOverride?: CapitalCostConfig,
    originChainOverride?: CapitalCostConfig
  ): void {
    const overrideCount = [routeOverride, destinationChainOverride, originChainOverride].filter(Boolean).length;

    if (overrideCount > 1) {
      const configUsed = routeOverride
        ? "route override"
        : destinationChainOverride
        ? "destination chain override"
        : originChainOverride
        ? "origin chain override"
        : "default override";

      this.logger.warn({
        at: "RelayFeeCalculator",
        message: `Multiple configurations found for token ${tokenSymbol} from chain ${originChain} to chain ${destChain}`,
        configUsed,
        routeOverride,
        destinationChainOverride,
        originChainOverride,
      });
    }
  }

  /**
   * Retrieves the relayer fee details for a deposit.
   * @param deposit A valid deposit object to reason about
   * @param amountToRelay The amount that the relayer would simulate a fill for
   * @param simulateZeroFill Whether to simulate a zero fill for the gas cost simulation
   *       For simulateZeroFill: A fill of 1 wei which would result in a slow/partial fill.
   *       You should do this if you're not worried about simulating a proper fill of a deposit
   *       with a message or if you are worried a fill amount that could exceed the balance of
   *       the relayer.
   * @param relayerAddress The relayer that will be used for the gas cost simulation
   * @param _tokenPrice The token price for normalizing fees
   * @param gasPrice Optional gas price to use for the simulation
   * @param gasUnits Optional gas units to use for the simulation
   * @returns A resulting `RelayerFeeDetails` object
   */
  async relayerFeeDetails(
    deposit: Deposit,
    outputAmount?: BigNumberish,
    simulateZeroFill = false,
    relayerAddress = toAddressType(getDefaultRelayer(deposit.destinationChainId), deposit.destinationChainId),
    _tokenPrice?: number,
    gasPrice?: BigNumberish,
    gasUnits?: BigNumberish,
    tokenGasCost?: BigNumberish
  ): Promise<RelayerFeeDetails> {
    // If the amount to relay is not provided, then we
    // should use the full deposit amount.
    outputAmount ??= deposit.outputAmount;
    const { inputToken, originChainId, outputToken, destinationChainId } = deposit;
    // We can perform a simple lookup with `getTokenInfo` here without resolving the exact token to resolve since we only need to
    // resolve the L1 token symbol and not the L2 token decimals.
    const inputTokenInfo = getTokenInfo(inputToken.toNative(), originChainId);
    const outputTokenInfo = getTokenInfo(outputToken.toNative(), destinationChainId);
    if (!isDefined(inputTokenInfo) || !isDefined(outputTokenInfo)) {
      throw new Error(`Could not find token information for ${inputToken} or ${outputToken}`);
    }

    const gasFeePercent = await this.gasFeePercent(
      deposit,
      outputAmount,
      simulateZeroFill,
      relayerAddress,
      _tokenPrice,
      undefined,
      gasPrice,
      gasUnits,
      tokenGasCost
    );
    const outToInDecimals = ConvertDecimals(outputTokenInfo.decimals, inputTokenInfo.decimals);
    const gasFeeTotal = gasFeePercent.mul(outToInDecimals(outputAmount.toString())).div(fixedPointAdjustment);
    const capitalFeePercent = this.capitalFeePercent(
      outputAmount,
      inputTokenInfo.symbol,
      deposit.originChainId.toString(),
      deposit.destinationChainId.toString()
    );
    const capitalFeeTotal = capitalFeePercent.mul(outToInDecimals(outputAmount.toString())).div(fixedPointAdjustment);
    const relayFeePercent = gasFeePercent.add(capitalFeePercent);
    const relayFeeTotal = gasFeeTotal.add(capitalFeeTotal);

    // We don't want the relayer to incur an excessive gas fee charge as a % of the deposited total.
    // The maximum gas fee % charged is equal to the remaining fee % leftover after subtracting the capital fee %
    // from the fee limit %. We then compute the minimum deposited amount required to not exceed the maximum
    // gas fee %: maxGasFeePercent = gasFeeTotal / minDeposit. Refactor this to figure out the minDeposit:
    // minDeposit = gasFeeTotal / maxGasFeePercent, and subsequently determine
    // isAmountTooLow = amountToRelay < minDeposit.
    const maxGasFeePercent = max(toBNWei(this.feeLimitPercent / 100).sub(capitalFeePercent), toBN(0));
    // If maxGasFee % is 0, then the min deposit should be infinite because there is no deposit amount that would
    // incur a non zero gas fee % charge. In this case, isAmountTooLow should always be true.
    let minDeposit: BigNumber, isAmountTooLow: boolean;
    if (maxGasFeePercent.eq(toBN(0))) {
      minDeposit = MAX_BIG_INT;
      isAmountTooLow = true;
    } else {
      minDeposit = gasFeeTotal.mul(fixedPointAdjustment).div(maxGasFeePercent);
      isAmountTooLow = toBN(outputAmount).lt(minDeposit);
    }

    return {
      amountToRelay: outputAmount.toString(),
      tokenSymbol: inputTokenInfo.symbol,
      gasFeePercent: gasFeePercent.toString(),
      gasFeeTotal: gasFeeTotal.toString(),
      gasDiscountPercent: this.gasDiscountPercent,
      capitalFeePercent: capitalFeePercent.toString(),
      capitalFeeTotal: capitalFeeTotal.toString(),
      capitalDiscountPercent: this.capitalDiscountPercent,
      relayFeePercent: relayFeePercent.toString(),
      relayFeeTotal: relayFeeTotal.toString(),
      feeLimitPercent: this.feeLimitPercent,
      maxGasFeePercent: maxGasFeePercent.toString(),
      minDeposit: minDeposit.toString(),
      isAmountTooLow,
    };
  }
}
