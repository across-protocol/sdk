import { CHAIN_IDs, MAINNET_CHAIN_IDs as _MAINNET_CHAIN_IDs, PUBLIC_NETWORKS } from "../constants";
import { RPCTransport } from "./types";

const MAINNET_CHAIN_IDs = Object.values(_MAINNET_CHAIN_IDs);

// Chain-specific overrides for when the endpoint name does not match the canonical chain name.
const endpoints: { [chainId: string]: string } = {
  [CHAIN_IDs.ARBITRUM]: "arb",
  [CHAIN_IDs.ARBITRUM_SEPOLIA]: "arb-sepolia",
  [CHAIN_IDs.MAINNET]: "eth",
  [CHAIN_IDs.SEPOLIA]: "eth-sepolia",
  [CHAIN_IDs.OPTIMISM]: "opt",
  [CHAIN_IDs.OPTIMISM_SEPOLIA]: "opt-sepolia",
  [CHAIN_IDs.WORLD_CHAIN]: "worldchain",
};

export function getURL(chainId: number, apiKey: string, transport: RPCTransport): string {
  let chain = endpoints[chainId] ?? PUBLIC_NETWORKS[chainId]?.name;
  if (!chain) {
    throw new Error(`No known Alchemy provider for chainId ${chainId}`);
  }

  if (MAINNET_CHAIN_IDs.includes(chainId)) {
    chain = `${chain}-mainnet`;
  }
  chain = chain.toLowerCase().replace(" ", "-");

  return `${transport}://${chain}.g.alchemy.com/v2/${apiKey}`;
}
