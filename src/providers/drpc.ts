import { CHAIN_IDs, MAINNET_CHAIN_IDs as _MAINNET_CHAIN_IDs, PUBLIC_NETWORKS } from "../constants";
import { RPCTransport } from "./types";

const MAINNET_CHAIN_IDs = Object.values(_MAINNET_CHAIN_IDs);

// Chain-specific overrides for when the Alchemy endpoint does not match the canonical chain name.
const endpoints: { [chainId: string]: string } = {
  [CHAIN_IDs.ARBITRUM]: "arbitrum",
  [CHAIN_IDs.MAINNET]: "ethereum",
  [CHAIN_IDs.SEPOLIA]: "sepolia",
};

export function getURL(chainId: number, apiKey: string, transport: RPCTransport): string {
  let host = endpoints[chainId] ?? PUBLIC_NETWORKS[chainId]?.name;
  if (!host) {
    throw new Error(`No known DRPC provider for chainId ${chainId}`);
  }
  host = host.toLowerCase().replace(" ", "-");
  const rpcType = transport === "https" ? "rpc" : "ws";

  return `${transport}://lb.drpc.org/og${rpcType}?network=${host}&dkey=${apiKey}`;
}
