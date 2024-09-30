import assert from "assert";
import { createPublicClient, http, Transport } from "viem";
import type { Chain, PublicClient } from "viem";
import * as chains from "viem/chains";

export function gasPriceError(method: string, chainId: number, data: unknown): void {
  throw new Error(`Malformed ${method} response on chain ID ${chainId} (${JSON.stringify(data)})`);
}

export function getPublicClient(chainId: number, transport?: Transport): PublicClient<Transport, Chain> {
  transport ??= http(); // @todo: Inherit URL from provider.
  const chain: Chain | undefined = Object.values(chains).find((chain) => chain.id === chainId);
  assert(chain);

  return createPublicClient({ chain, transport });
}
