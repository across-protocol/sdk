import web3, { RpcTransport } from "@solana/web3-v2.js";

/**
 * Helper to determine if the current RPC network is devnet.
 */
export async function isDevnet(rpc: web3.Rpc<web3.SolanaRpcApiFromTransport<RpcTransport>>): Promise<boolean> {
  const genesisHash = await rpc.getGenesisHash().send();
  return genesisHash === "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";
}
