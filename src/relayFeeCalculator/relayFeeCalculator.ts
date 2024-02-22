import assert from "assert";
import { BigNumber } from "ethers";
import {
  BigNumberish,
  bnZero,
  fixedPointAdjustment,
  toBNWei,
  nativeToToken,
  toBN,
  min,
  max,
  percent,
  MAX_BIG_INT,
  isDefined,
  isV2Deposit,
  getDepositInputToken,
  getDepositOutputAmount,
  getTokenInformationFromAddress,
  TransactionCostEstimate,
} from "../utils";
import { DEFAULT_SIMULATED_RELAYER_ADDRESS, TOKEN_SYMBOLS_MAP } from "../constants";
import { Deposit } from "../interfaces";

// This needs to be implemented for every chain and passed into RelayFeeCalculator
export interface QueryInterface {
  getGasCosts: (deposit: Deposit, fillAmount: BigNumberish, relayer: string) => Promise<TransactionCostEstimate>;
  getTokenPrice: (tokenSymbol: string) => Promise<number>;
  getTokenDecimals: (tokenSymbol: string) => number;
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
      for (const override of Object.values(toChainIdRoutes)) {
        this.validateCapitalCostsConfig(override);
      }
    }
    return config;
  }

  /**
   * Validates a CapitalCostConfig.
   * @param capitalCosts CapitalCostConfig
   */
  static validateCapitalCostsConfig(capitalCosts: CapitalCostConfig): void {
    assert(toBN(capitalCosts.upperBound).lt(toBNWei("0.01")), "upper bound must be < 1%");
    assert(toBN(capitalCosts.lowerBound).lte(capitalCosts.upperBound), "lower bound must be <= upper bound");
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
    amountToRelay: BigNumberish,
    simulateZeroFill = false,
    relayerAddress = DEFAULT_SIMULATED_RELAYER_ADDRESS,
    _tokenPrice?: number,
    tokenMapping = TOKEN_SYMBOLS_MAP
  ): Promise<BigNumber> {
    if (toBN(amountToRelay).eq(bnZero)) return MAX_BIG_INT;

    const inputToken = getDepositInputToken(deposit);
    const token = getTokenInformationFromAddress(inputToken, tokenMapping);
    if (!isDefined(token)) {
      throw new Error(`Could not find token information for ${inputToken}`);
    }

    // Reduce the output amount to simulate a full fill with a lower value to estimate
    // the fill cost accurately without risking a failure due to insufficient balance.
    const simulatedAmount = simulateZeroFill ? safeOutputAmount : toBN(amountToRelay);
    deposit = isV2Deposit(deposit)
      ? { ...deposit, amount: simulatedAmount }
      : { ...deposit, outputAmount: simulatedAmount };

    const getGasCosts = this.queries.getGasCosts(deposit, simulatedAmount, relayerAddress).catch((error) => {
      this.logger.error({
        at: "sdk-v2/gasFeePercent",
        message: "Error while fetching gas costs",
        error,
        simulateZeroFill,
        deposit,
      });
      throw error;
    });
    const getTokenPrice = this.queries.getTokenPrice(token.symbol).catch((error) => {
      this.logger.error({
        at: "sdk-v2/gasFeePercent",
        message: "Error while fetching token price",
        error,
        destinationChainId: deposit.destinationChainId,
        inputToken,
      });
      throw error;
    });
    const [{ tokenGasCost }, tokenPrice] = await Promise.all([
      getGasCosts,
      _tokenPrice !== undefined ? _tokenPrice : getTokenPrice,
    ]);
    const gasFeesInToken = nativeToToken(tokenGasCost, tokenPrice, token.decimals, this.nativeTokenDecimals);
    return percent(gasFeesInToken, amountToRelay.toString());
  }

  // Note: these variables are unused now, but may be needed in future versions of this function that are more complex.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  capitalFeePercent(
    _amountToRelay: BigNumberish,
    _tokenSymbol: string,
    _originRoute?: ChainIdAsString,
    _destinationRoute?: ChainIdAsString
  ): BigNumber {
    // If amount is 0, then the capital fee % should be the max 100%
    if (toBN(_amountToRelay).eq(toBN(0))) return MAX_BIG_INT;

    // V0: Ensure that there is a capital fee available for the token.
    // If not, then we should throw an error because this is indicative
    // of a misconfiguration.
    const tokenCostConfig = this.capitalCostsConfig[_tokenSymbol.toUpperCase()];
    if (!isDefined(tokenCostConfig)) {
      this.logger.error({
        at: "sdk-v2/capitalFeePercent",
        message: `No capital fee available for token ${_tokenSymbol}`,
      });
      throw new Error(`No capital cost config available for token ${_tokenSymbol}`);
    }
    // V1: Charge fee that scales with size. This will charge a fee % based on a linear fee curve with a "kink" at a
    // cutoff in the same units as _amountToRelay. Before the kink, the fee % will increase linearly from a lower
    // bound to an upper bound. After the kink, the fee % increase will be fixed, and slowly approach the upper bound
    // for very large amount inputs.
    else {
      const config =
        isDefined(_originRoute) && isDefined(_destinationRoute)
          ? tokenCostConfig.routeOverrides?.[_originRoute]?.[_destinationRoute] ?? tokenCostConfig.default
          : tokenCostConfig.default;

      // Scale amount "y" to 18 decimals.
      const y = toBN(_amountToRelay).mul(toBNWei("1", 18 - config.decimals));
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
   * @returns A resulting `RelayerFeeDetails` object
   */
  async relayerFeeDetails(
    deposit: Deposit,
    amountToRelay?: BigNumberish,
    simulateZeroFill = false,
    relayerAddress = DEFAULT_SIMULATED_RELAYER_ADDRESS,
    _tokenPrice?: number
  ): Promise<RelayerFeeDetails> {
    // If the amount to relay is not provided, then we
    // should use the full deposit amount.
    amountToRelay ??= getDepositOutputAmount(deposit);
    const inputToken = getDepositInputToken(deposit);
    const token = getTokenInformationFromAddress(inputToken);
    if (!isDefined(token)) {
      throw new Error(`Could not find token information for ${inputToken}`);
    }

    const gasFeePercent = await this.gasFeePercent(
      deposit,
      amountToRelay,
      simulateZeroFill,
      relayerAddress,
      _tokenPrice
    );
    const gasFeeTotal = gasFeePercent.mul(amountToRelay).div(fixedPointAdjustment);
    const capitalFeePercent = this.capitalFeePercent(
      amountToRelay,
      token.symbol,
      deposit.originChainId.toString(),
      deposit.destinationChainId.toString()
    );
    const capitalFeeTotal = capitalFeePercent.mul(amountToRelay).div(fixedPointAdjustment);
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
      isAmountTooLow = toBN(amountToRelay).lt(minDeposit);
    }

    return {
      amountToRelay: amountToRelay.toString(),
      tokenSymbol: token.symbol,
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
