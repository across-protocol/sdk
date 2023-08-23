import { PUBLIC_NETWORKS, DEFAULT_BLOCKCHAIN_EXPLORER_DOMAIN } from "../constants";
import { createShortHexString } from "./FormattingUtils";

/**
 * Creates a block explorer link for a transaction or address on a given network.
 * @param txHashOrAddress The transaction hash or address to link to.
 * @param chainId The chainId to link to.
 * @returns The block explorer link. This link will be formatted in markdown.
 */
export function blockExplorerLink(txHashOrAddress: string, chainId: number | string): string {
  return _createBlockExplorerLinkMarkdown(txHashOrAddress, Number(chainId)) ?? "<>";
}

/**
 * Resolves a domain to an block explorer link for a given network.
 * @param networkId The network to link to.
 * @returns The block explorer link. If the networkId is not supported, the default block explorer mainnet link will be returned.
 */
export function resolveBlockExplorerDomain(networkId: number): string {
  return PUBLIC_NETWORKS[networkId]?.etherscan ?? DEFAULT_BLOCKCHAIN_EXPLORER_DOMAIN;
}

/**
 * Generates a valid block explorer link for a given transaction hash or address.
 * @param hex The transaction hash or address to link to.
 * @param chainId The chainId to link to.
 * @returns A formatted markdown block explorer link to the given transaction hash or address on the given chainId.
 */
function _createBlockExplorerLinkMarkdown(hex: string, chainId = 1): string | null {
  if (hex.substring(0, 2) != "0x") {
    return null;
  }
  const shortURLString = createShortHexString(hex);
  // Transaction hash
  if (hex.length == 66) {
    return `<${resolveBlockExplorerDomain(chainId)}/tx/${hex}|${shortURLString}>`;
  }
  // Account
  else if (hex.length == 42) {
    return `<${resolveBlockExplorerDomain(chainId)}/address/${hex}|${shortURLString}>`;
  }
  return null;
}

/**
 * Generates a list of blockExplorer links for a given list of transaction hashes or addresses.
 * @param txHashesOrAddresses The list of transaction hashes or addresses to link to.
 * @param chainId The chainId to link to.
 * @returns A list of formatted markdown block explorer links to the given transaction hashes or addresses on the given chainId.
 * @see blockExplorerLink
 */
export function blockExplorer(txHashesOrAddresses: string[], chainId: number | string): string {
  return txHashesOrAddresses.map((hash) => `${blockExplorerLink(hash, chainId)}\n`).join("");
}
