import { CHAIN_IDs, PUBLIC_NETWORKS } from "../constants";
import { RPCTransport } from "./types";

export function getURL(chainId: number, apiKey: string, transport: RPCTransport): string {
  const envVar = "RPC_PROVIDER_QUICKNODE_PREFIX";
  const prefix = process.env[`${envVar}_${chainId}`] ?? process.env[envVar];
  if (!prefix) {
    throw new Error(`No API key prefix supplied for QuickNode (${envVar})`);
  }

  /* Ethereum and Optimism are special snowflakes */
  if (chainId === CHAIN_IDs.MAINNET) {
    return `${transport}://${prefix}.quicknode.pro/${apiKey}`;
  }

  if (chainId === CHAIN_IDs.OPTIMISM) {
    return `${transport}://${prefix}.optimism.quicknode.pro/${apiKey}`;
  }

  const chain = PUBLIC_NETWORKS[chainId]?.name.toLowerCase().replace(" ", "-");
  if (!chain) {
    throw new Error(`No known QuickNode provider for chainId ${chainId}`);
  }

  return `${transport}://${prefix}.${chain}.quicknode.pro/${apiKey}`;
}
