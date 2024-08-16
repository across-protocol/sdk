import { CHAIN_IDs, PUBLIC_NETWORKS } from "../constants";

// Chain-specific overrides for when the Alchemy endpoint does not match the canonical chain name.
const endpoints: { [chainId: string]: string } = {
  [CHAIN_IDs.ARBITRUM]: "arb-mainnet",
  [CHAIN_IDs.MAINNET]: "eth-mainnet",
  [CHAIN_IDs.OPTIMISM]: "opt-mainnet",
};

export function getURL(chainId: number, apiKey: string): string {
  const host = endpoints[chainId] ?? PUBLIC_NETWORKS[chainId]?.name;
  if (!host) {
    throw new Error(`No known Alchemy provider for chainId ${chainId}`);
  }

  return `https://${host.toLowerCase().replace(" ", "-")}.g.alchemy.com/v2/${apiKey}`;
}
