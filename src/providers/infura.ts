import { CHAIN_IDs, MAINNET_CHAIN_IDs as _MAINNET_CHAIN_IDs, PUBLIC_NETWORKS } from "../constants";
import { RPCTransport } from "./types";

const MAINNET_CHAIN_IDs = Object.values(_MAINNET_CHAIN_IDs);

// Chain-specific overrides for when the endpoint name does not match the canonical chain name.
const endpoints: { [chainId: string]: string } = {
  [CHAIN_IDs.ARBITRUM]: "arbitrum",
};

export function getURL(chainId: number, apiKey: string, transport: RPCTransport): string {
  let chain = endpoints[chainId] ?? PUBLIC_NETWORKS[chainId]?.name;
  if (!chain) {
    throw new Error(`No known Infura provider for chainId ${chainId}`);
  }

  if (chainId !== CHAIN_IDs.MAINNET && MAINNET_CHAIN_IDs.includes(chainId)) {
    chain = `${chain}-mainnet`;
  }
  chain = chain.toLowerCase().replace(" ", "-");

  return transport === "https" ? `https://${chain}.infura.io/v3/${apiKey}` : `wss://${chain}.infura.io/ws/v3/${apiKey}`;
}
