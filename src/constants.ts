import * as acxConstants from "@across-protocol/constants-v2";
import { constants as ethersConstants, BigNumber, utils } from "ethers";
export { CHAIN_IDs, TOKEN_SYMBOLS_MAP } from "@across-protocol/constants-v2";

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

/**
 * A default list of chain Ids that the protocol supports. This is outlined
 * in the UMIP (https://github.com/UMAprotocol/UMIPs/pull/590) and is used
 * to determine which chain Ids are supported by the protocol. As time progresses,
 * new chain Ids will be available in the Across ConfigStore contract, but
 * this list serves as a baseline set of chain Ids that the protocol supports
 * before the dynamic config store was introduced.
 */
export const PROTOCOL_DEFAULT_CHAIN_ID_INDICES = [1, 10, 137, 288, 42161];

// See src/utils/NetworkUtils for helpers.
export const PRODUCTION_CHAIN_IDS = [
  acxConstants.MAINNET_CHAIN_IDs.MAINNET,
  acxConstants.MAINNET_CHAIN_IDs.OPTIMISM,
  acxConstants.MAINNET_CHAIN_IDs.POLYGON,
  acxConstants.MAINNET_CHAIN_IDs.ZK_SYNC,
  acxConstants.MAINNET_CHAIN_IDs.BASE,
  acxConstants.MAINNET_CHAIN_IDs.ARBITRUM,
];

export const TESTNET_CHAIN_IDS = [
  acxConstants.TESTNET_CHAIN_IDs.GOERLI,
  acxConstants.TESTNET_CHAIN_IDs.ZK_SYNC_GOERLI,
  acxConstants.TESTNET_CHAIN_IDs.ZK_SYNC_SEPOLIA,
  acxConstants.TESTNET_CHAIN_IDs.OPTIMISM_GOERLI,
  acxConstants.TESTNET_CHAIN_IDs.MUMBAI,
  acxConstants.TESTNET_CHAIN_IDs.POLYGON_AMOY,
  acxConstants.TESTNET_CHAIN_IDs.BASE_GOERLI,
  acxConstants.TESTNET_CHAIN_IDs.BASE_SEPOLIA,
  acxConstants.TESTNET_CHAIN_IDs.ARBITRUM_GOERLI,
  acxConstants.TESTNET_CHAIN_IDs.ARBITRUM_SEPOLIA,
  acxConstants.TESTNET_CHAIN_IDs.SEPOLIA,
  acxConstants.TESTNET_CHAIN_IDs.OPTIMISM_SEPOLIA,
];

export const PUBLIC_NETWORKS: { [chainId: number]: { name: string; etherscan: string } } = {
  1: {
    name: "mainnet",
    etherscan: "https://etherscan.io",
  },
  5: { name: "goerli", etherscan: "https://goerli.etherscan.io" },
  10: { name: "optimism", etherscan: "https://optimistic.etherscan.io" },
  137: {
    name: "polygon-matic",
    etherscan: "https://polygonscan.com",
  },
  324: { name: "zksync", etherscan: "https://explorer.zksync.io" },
  8453: { name: "base", etherscan: "https://basescan.org" },
  42161: { name: "arbitrum", etherscan: "https://arbiscan.io" },
  43114: { name: "avalanche", etherscan: "https://snowtrace.io" },
  80002: { name: "polygon-amoy", etherscan: "https://www.oklink.com/amoy" },
  84531: { name: "base-goerli", etherscan: "https://basescan.org" },
  84532: { name: "base-sepolia", etherscan: "https://sepolia.basescan.org" },
  421613: { name: "arbitrum-goerli", etherscan: "https://goerli.arbiscan.io" },
  421614: { name: "arbitrum-sepolia", etherscan: "https://sepolia.arbiscan.io" },
  534351: { name: "scroll-sepolia", etherscan: "https://sepolia.scrollscan.com" },
  534352: { name: "scroll", etherscan: "https://scrollscan.com" },
  11155111: { name: "sepolia", etherscan: "https://sepolia.etherscan.io" },
  11155420: { name: "optimism-sepolia", etherscan: "https://sepolia-optimistic.etherscan.io" },
};

export const DEFAULT_BLOCKCHAIN_EXPLORER_DOMAIN = "https://etherscan.io";

export const DEFAULT_CACHING_TTL = 60 * 60 * 24 * 7 * 2; // 2 Weeks
export const DEFAULT_CACHING_SAFE_LAG = 60 * 60; // 1 hour

export const UBA_BOUNDS_RANGE_MAX = BigNumber.from(String(Number.MAX_SAFE_INTEGER)).mul(utils.parseEther("1.0"));
export const UBA_BOUNDS_RANGE_MIN = UBA_BOUNDS_RANGE_MAX.mul(-1);

export const DEFAULT_SIMULATED_RELAYER_ADDRESS = "0x428AB2BA90Eba0a4Be7aF34C9Ac451ab061AC010";
export const DEFAULT_SIMULATED_RELAYER_ADDRESS_TEST = "0x9A8f92a830A5cB89a3816e3D267CB7791c16b04D"; // Görli, ...

export const EMPTY_MESSAGE = "0x";
