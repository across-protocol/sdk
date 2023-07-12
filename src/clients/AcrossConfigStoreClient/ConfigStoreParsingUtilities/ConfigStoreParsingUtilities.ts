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
    alpha: Object.fromEntries(Object.entries(config.alpha).map(([key, value]) => [key, BigNumber.from(value)])),
    gamma: Object.fromEntries(
      Object.entries(config.gamma).map(([key, value]) => [
        key,
        {
          cutoff: value.cutoff.map((cutoff) => BigNumber.from(cutoff)),
          value: value.value.map((value) => BigNumber.from(value)),
        },
      ])
    ),
    omega: Object.fromEntries(
      Object.entries(config.omega).map(([key, value]) => [
        key,
        {
          cutoff: value.cutoff.map((cutoff) => BigNumber.from(cutoff)),
          value: value.value.map((value) => BigNumber.from(value)),
        },
      ])
    ),
    rebalance: Object.fromEntries(
      Object.entries(config.rebalance).map(([key, value]) => [
        key,
        {
          threshold_lower: BigNumber.from(value.threshold_lower),
          threshold_upper: BigNumber.from(value.threshold_upper),
          target_lower: BigNumber.from(value.target_lower),
          target_upper: BigNumber.from(value.target_upper),
        },
      ])
    ),
  };
}
