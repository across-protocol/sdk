import { ethers } from "ethers";
import { PUBLIC_NETWORKS } from "../constants";
import { createShortenedString } from "./FormattingUtils";
import { chainIsEvm } from "./NetworkUtils";
import { isDefined } from "./TypeGuards";
import bs58 from "bs58";

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
 * @returns The block explorer link. If the networkId is not supported, undefined will be returned.
 */
export function resolveBlockExplorerDomain(networkId: number): string | undefined {
  return PUBLIC_NETWORKS[networkId]?.blockExplorer;
}

/**
 * Constructs a URL for a given list of domain parts.
 * @param domain The domain to construct a URL for.
 * @param parts The relative path of parts to append to the domain. These parts will be joined with a "/".
 * @returns The constructed URL.
 * @see resolveBlockExplorerDomain
 * @example constructURL("https://example.com", ["path", "to", "resource"]) => "https://example.com/path/to/resource"
 * @example constructURL("https://example.com", ["path", "to", "resource", ""]) => "https://example.com/path/to/resource"
 * @example constructURL("https://example.com", ["path", "to//", "resource",]) => "https://example.com/path/to/resource"
 */
function constructURL(domain: string, parts: string[]): string {
  // Further split the parts by "/" to handle any parts that contain multiple "/".
  parts = parts.flatMap((p) => p.split("/"));
  // Remove any empty parts.
  parts = parts.filter((p) => p !== "");
  // Join the parts with a "/".
  const path = parts.join("/");
  // Remove any trailing "/".
  return `${domain}/${path}`.replace(/\/+$/, "");
}

/**
 * Generates a valid block explorer link for a given transaction hash or address.
 * @param hex The transaction hash or address to link to.
 * @param chainId The chainId to link to.
 * @returns A formatted markdown block explorer link to the given transaction hash or address on the given chainId.
 */
function _createBlockExplorerLinkMarkdown(addr: string, chainId = 1): string | null {
  // Attempt to resolve the block explorer domain for the given chainId.
  const explorerDomain = resolveBlockExplorerDomain(chainId);
  // If the chainId is not supported, return an unsupported link.
  if (!isDefined(explorerDomain)) {
    return `<unsupported chain/hash ${chainId}:${addr}>}`;
  }
  // Ensure that the first two characters are "0x". If they are not, append them.
  if (addr.substring(0, 2) !== "0x" && chainIsEvm(chainId)) {
    addr = `0x${addr}`;
    if (!ethers.utils.isHexString(addr)) {
      return null;
    }
  }
  // Resolve the short URL string.
  const shortURLString = createShortenedString(addr);
  if (chainIsEvm(chainId)) {
    // Iterate over the two possible addr lengths.
    for (const [length, route] of [
      [66, "tx"],
      [42, "address"],
    ] as [number, string][]) {
      // If the hex string is the correct length, return the link.
      if (addr.length === length) {
        return `<${constructURL(explorerDomain, [route, addr])} | ${shortURLString}>`;
      }
    }
  } else {
    const addrLength = bs58.decode(addr).length;
    const route = addrLength === 32 ? "account" : "tx";
    return `<${constructURL(explorerDomain, [route, addr])} | ${shortURLString}>`;
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
export function blockExplorerLinks(txHashesOrAddresses: string[], chainId: number | string): string {
  return txHashesOrAddresses.map((hash) => `${blockExplorerLink(hash, chainId)}\n`).join("");
}
