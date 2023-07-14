import { BigNumber } from "ethers";
import { UBAOnChainConfigType, UBAParsedConfigType } from "../../../interfaces";
import { UBA_CONFIG_ONCHAIN_SCHEMA } from "./superstructs";

/**
 * Type guard for UBAOnChainConfigType
 * @param input An unknown value that may or may not be a UBAOnChainConfigType
 * @returns True if the input is a UBAOnChainConfigType, false otherwise
 */
export function isUBAOnChainConfig(input: unknown): input is UBAOnChainConfigType {
  return UBA_CONFIG_ONCHAIN_SCHEMA.is(input);
}

/**
 * Parses a UBAOnChainConfigType into a UBAParsedConfigType
 * @param config The UBAOnChainConfigType to parse
 * @returns The parsed UBAParsedConfigType
 * @throws If the config is undefined
 * @throws If the config is not a UBAOnChainConfigType
 * @throws If the config is not valid
 */
export function parseUBAConfigFromOnChain(config?: UBAOnChainConfigType): UBAParsedConfigType {
  // Check that the config is defined
  if (!isUBAOnChainConfig(config)) {
    // If it's not, throw an error
    throw new Error("No config provided");
  }
  return {
    incentivePoolAdjustment: Object.fromEntries(
      Object.entries(config.incentivePoolAdjustment ?? {}).map(([key, value]) => [key, BigNumber.from(value)])
    ),
    ubaRewardMultiplier: Object.fromEntries(
      Object.entries(config.ubaRewardMultiplier ?? {}).map(([key, value]) => [key, BigNumber.from(value)])
    ),
    alpha: Object.fromEntries(Object.entries(config.alpha).map(([key, value]) => [key, BigNumber.from(value)])),
    gamma: Object.fromEntries(
      Object.entries(config.gamma).map(([key, value]) => [
        key,
        value.map((tuple) => tuple.map((value) => BigNumber.from(value)) as [BigNumber, BigNumber]),
      ])
    ),
    omega: Object.fromEntries(
      Object.entries(config.omega).map(([key, value]) => [
        key,
        value.map((tuple) => tuple.map((value) => BigNumber.from(value)) as [BigNumber, BigNumber]),
      ])
    ),
    rebalance: Object.fromEntries(
      Object.entries(config.rebalance).map(
        ([key, { threshold_lower, threshold_upper, target_lower, target_upper }]) => {
          const upperExists = threshold_upper !== undefined && target_upper !== undefined;
          const lowerExists = threshold_lower !== undefined && target_lower !== undefined;
          return [
            key,
            {
              threshold_lower: lowerExists ? BigNumber.from(threshold_lower) : undefined,
              target_lower: lowerExists ? BigNumber.from(target_lower) : undefined,
              threshold_upper: upperExists ? BigNumber.from(threshold_upper) : undefined,
              target_upper: upperExists ? BigNumber.from(target_upper) : undefined,
            },
          ];
        }
      )
    ),
  };
}
