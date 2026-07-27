import { CHAIN_IDs, MAINNET_CHAIN_IDs as _MAINNET_CHAIN_IDs, PUBLIC_NETWORKS } from "../constants";
import { isDefined } from "../utils/TypeGuards";
import { RPCTransport } from "./types";

const SNOWFLAKES = {
  [CHAIN_IDs.ARBITRUM]: "arbitrum-mainnet",
  [CHAIN_IDs.BSC]: "bsc",
  [CHAIN_IDs.POLYGON]: "matic",
  [CHAIN_IDs.OPTIMISM]: "optimism",
  [CHAIN_IDs.WORLD_CHAIN]: "worldchain-mainnet",
  [CHAIN_IDs.HYPEREVM]: "hype-mainnet",
};
const SNOWFLAKE_CHAIN_IDs = Object.keys(SNOWFLAKES).map(Number);
const MAINNET_CHAIN_IDs = Object.values(_MAINNET_CHAIN_IDs).map(Number);

/* Some chains nest their EVM RPC beneath a chain-specific path (avalanchego API structure, node flavors, ...). */
const PATHS: { [chainId: number]: { [transport in RPCTransport]?: string } } = {
  [CHAIN_IDs.AVALANCHE]: { https: "ext/bc/C/rpc", wss: "ext/bc/C/ws" },
  [CHAIN_IDs.HYPEREVM]: { https: "nanoreth", wss: "nanoreth" }, // Archive (nanoreth) flavor.
  [CHAIN_IDs.TRON]: { https: "jsonrpc" }, // QuickNode TRON has no WebSocket support.
};

export function getURL(chainId: number, apiKey: string, transport: RPCTransport): string {
  const envVar = "RPC_PROVIDER_KEY_QUICKNODE_PREFIX";
  const prefix = process.env[`${envVar}_${chainId}`] ?? process.env[envVar];
  if (!prefix) {
    throw new Error(`No API key prefix supplied for QuickNode (${envVar})`);
  }

  const domain = "quiknode.pro"; // nb. quiknode, not quicknode

  /* Some chains are special snowflakes */
  if (chainId === CHAIN_IDs.MAINNET) {
    return `${transport}://${prefix}.${domain}/${apiKey}`;
  }

  let chain = SNOWFLAKES[chainId] ?? PUBLIC_NETWORKS[chainId]?.name;
  if (!chain) {
    throw new Error(`No known QuickNode provider for chainId ${chainId}`);
  }

  if (MAINNET_CHAIN_IDs.includes(chainId) && !SNOWFLAKE_CHAIN_IDs.includes(chainId)) {
    chain += "-mainnet";
  }
  chain = chain.toLowerCase().replace(" ", "-");

  const path = PATHS[chainId]?.[transport];

  return isDefined(path)
    ? `${transport}://${prefix}.${chain}.${domain}/${apiKey}/${path}`
    : `${transport}://${prefix}.${chain}.${domain}/${apiKey}`;
}
