import { PUBLIC_NETWORKS } from "../constants";

// Chain-specific overrides for when the Infura endpoint does not match the canonical chain name.
const endpoints: { [chainId: string]: string } = {};

export function getURL(chainId: number, apiKey: string): string {
  let host = endpoints[chainId] ?? PUBLIC_NETWORKS[chainId]?.name;
  if (!host) {
    throw new Error(`No known Infura provider for chainId ${chainId}`);
  }

  return `https://${host.toLowerCase().replace(" ", "-")}.infura.io/v3/${apiKey}`;
}
