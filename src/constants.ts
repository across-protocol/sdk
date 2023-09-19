import { constants as ethersConstants, BigNumber, utils } from "ethers";
export { CHAIN_IDs, TOKEN_SYMBOLS_MAP } from "@across-protocol/contracts-v2/dist/utils/constants";

export const { AddressZero: ZERO_ADDRESS } = ethersConstants;

// 2^96 - 1 is a conservative erc20 max allowance.
export const MAX_SAFE_ALLOWANCE = "79228162514264337593543950335";

export const SECONDS_PER_YEAR = 31557600; // 365.25 days per year.

/**
 * This is the protocol default chain Id for the hub pool.
 */
export const HUBPOOL_CHAIN_ID = 1;

// List of versions where certain UMIP features were deprecated
export const TRANSFER_THRESHOLD_MAX_CONFIG_STORE_VERSION = 2;

/**
 * A default list of chain Ids that the protocol supports. This is outlined
 * in the UMIP (https://github.com/UMAprotocol/UMIPs/pull/590) and is used
 * to determine which chain Ids are supported by the protocol. As time progresses,
 * new chain Ids will be available in the Across ConfigStore contract, but
 * this list serves as a baseline set of chain Ids that the protocol supports
 * before the dynamic config store was introduced.
 */
export const PROTOCOL_DEFAULT_CHAIN_ID_INDICES = [1, 10, 137, 288, 42161];

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
  84531: { name: "base-goerli", etherscan: "https://basescan.org" },
  421613: { name: "arbitrum-goerli", etherscan: "https://goerli.arbiscan.io" },
};

export const DEFAULT_BLOCKCHAIN_EXPLORER_DOMAIN = "https://etherscan.io";

export const DEFAULT_CACHING_TTL = 60 * 60 * 24 * 7 * 2; // 2 Weeks

export const UBA_BOUNDS_RANGE_MAX = BigNumber.from(String(Number.MAX_SAFE_INTEGER)).mul(utils.parseEther("1.0"));
export const UBA_BOUNDS_RANGE_MIN = UBA_BOUNDS_RANGE_MAX.mul(-1);

