export { CHAIN_IDs, TOKEN_SYMBOLS_MAP } from "@across-protocol/contracts-v2/dist/utils/constants";
export const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

export const HUBPOOL_CHAIN_ID = 1;

/**
 * This array contains all chains that Across supports, although some of the chains could be currently disabled.
 * The order of the chains is important to not change, as the dataworker proposes "bundle block numbers" per chain
 * in the same order as the following list. To add a new chain ID, append it to the end of the list. Never delete
 * a chain ID. The on-chain ConfigStore should store a list of enabled/disabled chain ID's that are a subset
 * of this list, so this list is simply the list of all possible Chain ID's that Across could support.
**/
export const CHAIN_ID_LIST_INDICES = [1, 10, 137, 288, 42161];
