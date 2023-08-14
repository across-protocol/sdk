export { CHAIN_IDs, TOKEN_SYMBOLS_MAP } from "@across-protocol/contracts-v2/dist/utils/constants";
export const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

/**
 * This is the protocol default chain Id for the hub pool.
 */
export const HUBPOOL_CHAIN_ID = 1;

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
    etherscan: "https://etherscan.io/",
  },
  5: { name: "goerli", etherscan: "https://goerli.etherscan.io/" },
  10: { name: "optimism", etherscan: "https://optimistic.etherscan.io/" },
  137: {
    name: "polygon-matic",
    etherscan: "https://polygonscan.com/",
  },
  324: { name: "zksync", etherscan: "https://explorer.zksync.io/" },
  8453: { name: "base", etherscan: "https://mainnet.basescan.org" },
  42161: { name: "arbitrum", etherscan: "https://arbiscan.io/" },
  43114: { name: "avalanche", etherscan: "https://snowtrace.io/" },
  84531: { name: "base-goerli", etherscan: "https://basescan.org" },
  421613: { name: "arbitrum-goerli", etherscan: "https://goerli.arbiscan.io/" },
};
