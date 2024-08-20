import { CHAIN_IDs, MAINNET_CHAIN_IDs as _MAINNET_CHAIN_IDs, PUBLIC_NETWORKS } from "../constants";
import { RPCTransport } from "./types";

const MAINNET_CHAIN_IDs = Object.values(_MAINNET_CHAIN_IDs);

// Chain-specific overrides for when the Alchemy endpoint does not match the canonical chain name.
const endpoints: { [chainId: string]: string } = {
  [CHAIN_IDs.ARBITRUM]: "arb",
  [CHAIN_IDs.ARBITRUM_SEPOLIA]: "arb-sepolia",
  [CHAIN_IDs.MAINNET]: "eth",
  [CHAIN_IDs.SEPOLIA]: "eth-sepolia",
  [CHAIN_IDs.OPTIMISM]: "opt",
  [CHAIN_IDs.OPTIMISM_SEPOLIA]: "opt-sepolia",
};

export function getURL(chainId: number, apiKey: string, transport: RPCTransport): string {
  let host = endpoints[chainId] ?? PUBLIC_NETWORKS[chainId]?.name;
  if (!host) {
    throw new Error(`No known Alchemy provider for chainId ${chainId}`);
  }

  if (MAINNET_CHAIN_IDs.includes(chainId)) {
    host = `${host}-mainnet`;
  }
  host = host.toLowerCase().replace(" ", "-");

  return `${transport}://${host}.g.alchemy.com/v2/${apiKey}`;
}
