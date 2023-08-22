import { PUBLIC_NETWORKS, DEFAULT_BLOCKCHAIN_EXPLORER_DOMAIN } from "../constants";
import { createShortHexString } from "./FormattingUtils";

/**
 * Creates an etherscan link for a transaction or address on a given network.
 * @param txHashOrAddress The transaction hash or address to link to.
 * @param chainId The chainId to link to.
 * @returns The etherscan link. This link will be formatted in markdown.
 */
export function etherscanLink(txHashOrAddress: string, chainId: number | string): string {
  return _createEtherscanLinkMarkdown(txHashOrAddress, Number(chainId)) ?? "<>";
}

/**
 * Resolves a domain to an etherscan link for a given network.
 * @param networkId The network to link to.
 * @returns The etherscan link. If the networkId is not supported, the default etherscan mainnet link will be returned.
 */
export function createEtherscanLinkFromTx(networkId: number): string {
  return PUBLIC_NETWORKS[networkId]?.etherscan ?? DEFAULT_BLOCKCHAIN_EXPLORER_DOMAIN;
}

/**
 * Generates a valid etherscan link for a given transaction hash or address.
 * @param hex The transaction hash or address to link to.
 * @param chainId The chainId to link to.
 * @returns A formatted markdown etherscan link to the given transaction hash or address on the given chainId.
 */
function _createEtherscanLinkMarkdown(hex: string, chainId = 1): string | null {
  if (hex.substring(0, 2) != "0x") {
    return null;
  }
  const shortURLString = createShortHexString(hex);
  // Transaction hash
  if (hex.length == 66) {
    return `<${createEtherscanLinkFromTx(chainId)}tx/${hex}|${shortURLString}>`;
  }
  // Account
  else if (hex.length == 42) {
    return `<${createEtherscanLinkFromTx(chainId)}address/${hex}|${shortURLString}>`;
  }
  return null;
}

/**
 * Generates a list of etherscan links for a given list of transaction hashes or addresses.
 * @param txHashesOrAddresses The list of transaction hashes or addresses to link to.
 * @param chainId The chainId to link to.
 * @returns A list of formatted markdown etherscan links to the given transaction hashes or addresses on the given chainId.
 * @see etherscanLink
 */
export function etherscanLinks(txHashesOrAddresses: string[], chainId: number | string): string {
  return txHashesOrAddresses.map((hash) => `${etherscanLink(hash, chainId)}\n`).join("");
}
