import { constants as ethersConstants } from "ethers";
import { CHAIN_IDs, TOKEN_SYMBOLS_MAP } from "@across-protocol/constants";

export {
  ChainFamily,
  CHAIN_IDs,
  MAINNET_CHAIN_IDs,
  PUBLIC_NETWORKS,
  TESTNET_CHAIN_IDs,
  TOKEN_SYMBOLS_MAP,
} from "@across-protocol/constants";

export const { AddressZero: ZERO_ADDRESS, HashZero: ZERO_BYTES } = ethersConstants;

// 2^96 - 1 is a conservative erc20 max allowance.
export const MAX_SAFE_ALLOWANCE = "79228162514264337593543950335";

// The maximum depositId that can be emitted in a depositV3 method is the maximum uint32 value, so
// 2^32 - 1.
export const MAX_SAFE_DEPOSIT_ID = "4294967295";

export const SECONDS_PER_YEAR = 31557600; // 365.25 days per year.

/**
 * This is the protocol default chain Id for the hub pool.
 */
export const HUBPOOL_CHAIN_ID = 1;

// List of versions where certain UMIP features were deprecated or activated
export const TRANSFER_THRESHOLD_MAX_CONFIG_STORE_VERSION = 1;

// A hardcoded identifier used, by default, to tag all Arweave records.
export const ARWEAVE_TAG_APP_NAME = "across-protocol";

// A hardcoded version number used, by default, to tag all Arweave records.
export const ARWEAVE_TAG_APP_VERSION = 3;

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

export const DEFAULT_SIMULATED_RELAYER_ADDRESS = "0x07aE8551Be970cB1cCa11Dd7a11F47Ae82e70E67";
export const DEFAULT_SIMULATED_RELAYER_ADDRESS_TEST = "0x9A8f92a830A5cB89a3816e3D267CB7791c16b04D"; // Görli, ...

export const DEFAULT_ARWEAVE_STORAGE_ADDRESS = "Z6hjBM8FHu90lYWB8o5jR1dfX92FlV2WBaND9xgp8Lg";

export const EMPTY_MESSAGE = "0x";

export const BRIDGED_USDC_SYMBOLS = [
  TOKEN_SYMBOLS_MAP["USDC.e"].symbol,
  TOKEN_SYMBOLS_MAP.USDbC.symbol,
  TOKEN_SYMBOLS_MAP.USDzC.symbol,
];

export const CUSTOM_GAS_TOKENS = {
  [CHAIN_IDs.POLYGON]: "MATIC",
  [CHAIN_IDs.POLYGON_AMOY]: "MATIC",
  [CHAIN_IDs.ALEPH_ZERO]: "AZERO",
  // FIXME: Replace with GRASS price once listed on Coingecko.
  // For testing purposes, we use ETH price instead.
  [CHAIN_IDs.LENS_SEPOLIA]: "ETH",
};
