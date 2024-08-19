import { MAINNET_CHAIN_IDs as _MAINNET_CHAIN_IDs, PUBLIC_NETWORKS } from "../constants";
import { RPCTransport } from "./types";

const MAINNET_CHAIN_IDs = Object.values(_MAINNET_CHAIN_IDs);

// Chain-specific overrides for when the Infura endpoint does not match the canonical chain name.
const endpoints: { [chainId: string]: string } = {};

export function getURL(chainId: number, apiKey: string, transport: RPCTransport): string {
  let host = endpoints[chainId] ?? PUBLIC_NETWORKS[chainId]?.name;
  if (!host) {
    throw new Error(`No known Infura provider for chainId ${chainId}`);
  }

  if (MAINNET_CHAIN_IDs.includes(chainId)) {
    host = `${host}-mainnet`;
  }
  host = host.toLowerCase().replace(" ", "-");

  return transport === "HTTPS" ? `https://${host}.infura.io/v3/${apiKey}` : `wss://${host}.infura.is/ws/v3/${apiKey}`;
}
