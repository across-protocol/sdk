import { CHAIN_IDs, PUBLIC_NETWORKS } from "../constants";
import { RPCTransport } from "./types";

// Chain-specific overrides for when the endpoint name does not match the canonical chain name.
const endpoints: { [chainId: string]: string } = {
  [CHAIN_IDs.ARBITRUM]: "arbitrum",
  [CHAIN_IDs.MAINNET]: "ethereum",
};

export function getURL(chainId: number, apiKey: string, transport: RPCTransport): string {
  let chain = endpoints[chainId] ?? PUBLIC_NETWORKS[chainId]?.name;
  if (!chain) {
    throw new Error(`No known DRPC provider for chainId ${chainId}`);
  }
  chain = chain.toLowerCase().replace(" ", "-");
  const rpcType = transport === "https" ? "rpc" : "ws";

  return `${transport}://lb.drpc.org/og${rpcType}?network=${chain}&dkey=${apiKey}`;
}
