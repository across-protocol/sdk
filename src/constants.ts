import { constants as ethersConstants, BigNumber, utils } from "ethers";

export {
  CHAIN_IDs,
  MAINNET_CHAIN_IDs,
  PUBLIC_NETWORKS,
  TESTNET_CHAIN_IDs,
  TOKEN_SYMBOLS_MAP,
} from "@across-protocol/constants";

export const { AddressZero: ZERO_ADDRESS } = ethersConstants;

// 2^96 - 1 is a conservative erc20 max allowance.
export const MAX_SAFE_ALLOWANCE = "79228162514264337593543950335";

export const SECONDS_PER_YEAR = 31557600; // 365.25 days per year.

/**
 * This is the protocol default chain Id for the hub pool.
 */
export const HUBPOOL_CHAIN_ID = 1;

// List of versions where certain UMIP features were deprecated
export const TRANSFER_THRESHOLD_MAX_CONFIG_STORE_VERSION = 1;

// A hardcoded identifier used, by default, to tag all Arweave records.
export const ARWEAVE_TAG_APP_NAME = "across-protocol";

// A hardcoded version number used, by default, to tag all Arweave records.
export const ARWEAVE_TAG_APP_VERSION = 2;

/**
 * A default list of chain Ids that the protocol supports. This is outlined
 * in the UMIP (https://github.com/UMAprotocol/UMIPs/pull/590) and is used
 * to determine which chain Ids are supported by the protocol. As time progresses,
 * new chain Ids will be available in the Across ConfigStore contract, but
 * this list serves as a baseline set of chain Ids that the protocol supports
 * before the dynamic config store was introduced.
 */
export const PROTOCOL_DEFAULT_CHAIN_ID_INDICES = [1, 10, 137, 288, 42161];

export const DEFAULT_CACHING_TTL = 60 * 60 * 24 * 7 * 2; // 2 Weeks
export const DEFAULT_CACHING_SAFE_LAG = 60 * 60; // 1 hour

export const UBA_BOUNDS_RANGE_MAX = BigNumber.from(String(Number.MAX_SAFE_INTEGER)).mul(utils.parseEther("1.0"));
export const UBA_BOUNDS_RANGE_MIN = UBA_BOUNDS_RANGE_MAX.mul(-1);

export const DEFAULT_SIMULATED_RELAYER_ADDRESS = "0x428AB2BA90Eba0a4Be7aF34C9Ac451ab061AC010";
export const DEFAULT_SIMULATED_RELAYER_ADDRESS_TEST = "0x9A8f92a830A5cB89a3816e3D267CB7791c16b04D"; // Görli, ...

export const DEFAULT_ARWEAVE_STORAGE_ADDRESS = "Z6hjBM8FHu90lYWB8o5jR1dfX92FlV2WBaND9xgp8Lg";

export const EMPTY_MESSAGE = "0x";
