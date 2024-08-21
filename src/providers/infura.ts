import { CHAIN_IDs, MAINNET_CHAIN_IDs as _MAINNET_CHAIN_IDs, PUBLIC_NETWORKS } from "../constants";
import { RPCTransport } from "./types";

const MAINNET_CHAIN_IDs = Object.values(_MAINNET_CHAIN_IDs);

// Chain-specific overrides for when the Infura endpoint does not match the canonical chain name.
const endpoints: { [chainId: string]: string } = {
  [CHAIN_IDs.ARBITRUM]: "arbitrum",
};

export function getURL(chainId: number, apiKey: string, transport: RPCTransport): string {
  let host = endpoints[chainId] ?? PUBLIC_NETWORKS[chainId]?.name;
  if (!host) {
    throw new Error(`No known Infura provider for chainId ${chainId}`);
  }

  if (chainId !== CHAIN_IDs.MAINNET && MAINNET_CHAIN_IDs.includes(chainId)) {
    host = `${host}-mainnet`;
  }
  host = host.toLowerCase().replace(" ", "-");

  return transport === "https" ? `https://${host}.infura.io/v3/${apiKey}` : `wss://${host}.infura.io/ws/v3/${apiKey}`;
}
