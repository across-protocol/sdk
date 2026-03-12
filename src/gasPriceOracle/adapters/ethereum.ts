import assert from "assert";
import { providers } from "ethers";
import { BigNumber, bnZero, fixedPointAdjustment, getNetworkName, bnOne, isDefined } from "../../utils";
import { EvmGasPriceEstimate } from "../types";
import { gasPriceError } from "../util";
import { GasPriceEstimateOptions } from "../oracle";

/**
 * @dev Constructs total fee by adding eth_getBlock("pending").baseFee to eth_maxPriorityFeePerGas
 * @param provider ethers RPC provider instance.
 * @param {GasPriceEstimateOptions} opts See notes below on specific parameters.
 * @param baseFeeMultiplier Amount to multiply base fee or total fee for legacy gas pricing.
 * @param priorityFeeMultiplier Amount to multiply priority fee or unused for legacy gas pricing.
 * @returns Promise of gas price estimate object.
 */
export function eip1559(provider: providers.Provider, opts: GasPriceEstimateOptions): Promise<EvmGasPriceEstimate> {
  return eip1559Raw(provider, opts.chainId, opts.baseFeeMultiplier, opts.priorityFeeMultiplier);
}

/**
 * @note Performs direct RPC calls to retrieve the RPC-suggested priority fee for the next block.
 * @dev Constructs total fee by adding eth_getBlock("pending").baseFee to eth_maxPriorityFeePerGas
 * @param provider ethers RPC provider instance.
 * @param chainId Chain ID of the provider instance.
 * @returns Promise of gas price estimate object.
 */
export async function eip1559Raw(
  provider: providers.Provider,
  chainId: number,
  baseFeeMultiplier: BigNumber,
  priorityFeeMultiplier: BigNumber
): Promise<EvmGasPriceEstimate> {
  const [{ baseFeePerGas }, _maxPriorityFeePerGas] = await Promise.all([
    provider.getBlock("latest"),
    (provider as providers.JsonRpcProvider).send("eth_maxPriorityFeePerGas", []),
  ]);
  const maxPriorityFeePerGas = BigNumber.from(_maxPriorityFeePerGas);
  assert(BigNumber.isBigNumber(baseFeePerGas), `No baseFeePerGas received on ${getNetworkName(chainId)}`);

  const scaledPriorityFee = maxPriorityFeePerGas.mul(priorityFeeMultiplier).div(fixedPointAdjustment);
  const scaledBaseFee = baseFeePerGas.mul(baseFeeMultiplier).div(fixedPointAdjustment);
  return {
    maxFeePerGas: scaledPriorityFee.add(scaledBaseFee),
    maxPriorityFeePerGas: scaledPriorityFee,
  };
}

/**
 * @notice Derives an appropriate maxPriorityFeePerGas by applying a predicate to historical rewards specified by eth_feeHistory.
 * @param provider ethers RPC provider instance.
 * @param {GasPriceEstimateOptions} Gas scaling options.
 */
export async function feeHistory(
  provider: providers.Provider,
  opts: GasPriceEstimateOptions
): Promise<EvmGasPriceEstimate> {
  // Get the fee history options and populate unspecified properties with defaults.
  const { baseFeeMultiplier, feeHistoryOptions } = opts;
  assert(isDefined(feeHistoryOptions)); // We can only get here normally if feeHistoryOptions is defined.
  const { percentile = 20, blockLookback = 10, minimumPriority = bnOne } = feeHistoryOptions;

  const [{ baseFeePerGas }, feeHistory] = await Promise.all([
    provider.getBlock("latest"),
    (provider as providers.JsonRpcProvider).send("eth_feeHistory", [blockLookback, "latest", [percentile]]),
  ]);
  assert(BigNumber.isBigNumber(baseFeePerGas), "No baseFeePerGas received on latest block query.");

  // Default estimator based on https://github.com/alloy-rs/alloy/blob/6f20815b657f60de454bed5010e3b9a6883ac70f/crates/provider/src/utils.rs#L90
  const defaultEstimator = (rewards: BigNumber[]): BigNumber => {
    const sortedRewards = rewards
      .filter((reward) => reward.gt(bnZero))
      .sort((r1, r2) => {
        if (r1.gt(r2)) {
          return 1;
        }
        return r1.eq(r2) ? 0 : -1;
      });

    // If all historical rewards are 0, then return the specified minimum.
    if (sortedRewards.length === 0) {
      return minimumPriority;
    }

    const n = sortedRewards.length;
    const median = n % 2 === 0 ? sortedRewards[n / 2 - 1].add(sortedRewards[n / 2].div(2)) : sortedRewards[n / 2];
    return median.gt(minimumPriority) ? median : minimumPriority;
  };

  const { estimator = defaultEstimator } = feeHistoryOptions;
  const maxPriorityFeePerGas = estimator(feeHistory.rewards);
  const scaledBaseFee = baseFeePerGas.mul(baseFeeMultiplier).div(fixedPointAdjustment);

  return {
    maxFeePerGas: scaledBaseFee.add(maxPriorityFeePerGas),
    maxPriorityFeePerGas,
  };
}

/**
 * @notice Returns result of eth_gasPrice RPC call
 * @dev Its recommended to use the eip1559Raw method over this one where possible as it will be more accurate.
 * @returns GasPriceEstimate
 */
export async function legacy(
  provider: providers.Provider,
  opts: GasPriceEstimateOptions
): Promise<EvmGasPriceEstimate> {
  const { chainId, baseFeeMultiplier } = opts;
  const gasPrice = await provider.getGasPrice();

  if (!BigNumber.isBigNumber(gasPrice) || gasPrice.lt(bnZero)) gasPriceError("getGasPrice()", chainId, gasPrice);

  return {
    maxFeePerGas: gasPrice.mul(baseFeeMultiplier).div(fixedPointAdjustment),
    maxPriorityFeePerGas: bnZero,
  };
}
