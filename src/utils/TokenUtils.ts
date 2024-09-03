import { BlockTag } from "@ethersproject/abstract-provider";
import { BigNumber, Contract, providers, Signer } from "ethers";
import * as constants from "../constants";
import { L1Token } from "../interfaces";
import { ERC20__factory } from "../typechain";
import { getNetworkName } from "./NetworkUtils";
import { isDefined } from "./TypeGuards";
import { compareAddressesSimple } from "./AddressUtils";
const { TOKEN_SYMBOLS_MAP, CHAIN_IDs } = constants;

type SignerOrProvider = providers.Provider | Signer;

export async function fetchTokenInfo(address: string, signerOrProvider: SignerOrProvider): Promise<L1Token> {
  const token = new Contract(address, ERC20__factory.abi, signerOrProvider);
  const [symbol, decimals] = await Promise.all([token.symbol(), token.decimals()]);
  return { address, symbol, decimals };
}

export const getL2TokenAddresses = (
  l1TokenAddress: string,
  l1ChainId = CHAIN_IDs.MAINNET
): { [chainId: number]: string } | undefined => {
  return Object.values(TOKEN_SYMBOLS_MAP).find((details) => {
    return details.addresses[l1ChainId] === l1TokenAddress;
  })?.addresses;
};

/**
 * Resolve a token symbol to an L1Token description on a particular chain ID.
 * @notice Not to be confused with the HubPool's internal view on the supported origin/destination token for a chain.
 * @param symbol Symbol to query.
 * @param chainId Chain ID to query on.
 * @returns Symbol, decimals and contract address on the requested chain.
 */
export function resolveSymbolOnChain(chainId: number, symbol: string): L1Token {
  // @dev Suppress tsc complaints by casting symbol to the expected type.
  const token = TOKEN_SYMBOLS_MAP[symbol as keyof typeof TOKEN_SYMBOLS_MAP];
  if (!isDefined(token) || !isDefined(token.addresses[chainId])) {
    const network = getNetworkName(chainId);
    throw new Error(`Unable to find token ${symbol} on ${network} (chain ID ${chainId}`);
  }

  const { decimals, addresses } = token;
  const address = addresses[chainId];

  return { symbol, decimals, address };
}

/**
 * Returns the contract address for a given token symbol and chainId.
 * @param symbol A case-insensitive token symbol.
 * @param chainId The chainId to resolve the contract address for.
 * @param tokenMapping A parameter to determine where to source token information. Defaults to the constants variant.
 * @returns The contract address for the given token symbol and chainId, or undefined if the token symbol is not supported.
 */
export const resolveContractFromSymbol = (
  symbol: string,
  chainId: string,
  tokenMapping = TOKEN_SYMBOLS_MAP
): string | undefined => {
  return Object.values(tokenMapping).find((details) => {
    return details.symbol.toLowerCase() === symbol.toLowerCase();
  })?.addresses[Number(chainId)];
};

export function getTokenInformationFromAddress(address: string, tokenMapping = TOKEN_SYMBOLS_MAP): L1Token | undefined {
  const details = Object.values(tokenMapping).find((details) => {
    return Object.values(details.addresses).some((t) => t.toLowerCase() === address.toLowerCase());
  });
  return isDefined(details)
    ? {
        decimals: details.decimals,
        symbol: details.symbol,
        address,
      }
    : undefined;
}

export function getCoingeckoTokenIdByAddress(contractAddress: string): string {
  const token = getTokenInformationFromAddress(contractAddress);
  if (!token) {
    throw new Error(`Token with address ${contractAddress} not found in token mapping`);
  }
  return TOKEN_SYMBOLS_MAP[token.symbol as keyof typeof TOKEN_SYMBOLS_MAP].coingeckoId;
}

/**
 * Retrieves the ERC20 balance for a given address and token address.
 * @param address The address to retrieve the balance for.
 * @param tokenAddress The token address
 * @param signerOrProvider A valid ethers.js Signer or Provider object.
 * @param blockTag The block tag to retrieve the balance at.
 * @returns The balance of the given address for the given token address.
 */
export function getTokenBalance(
  address: string,
  tokenAddress: string,
  signerOrProvider: SignerOrProvider,
  blockTag: BlockTag = "latest"
): Promise<BigNumber> {
  const token = ERC20__factory.connect(tokenAddress, signerOrProvider);
  return token.balanceOf(address, { blockTag });
}

export function isBridgedUsdc(tokenSymbol: string): boolean {
  return !!constants.BRIDGED_USDC_SYMBOLS.find(
    (bridgedUsdcSymbol) => bridgedUsdcSymbol.toLowerCase() === tokenSymbol.toLowerCase()
  );
}

export function getTokenInfo(l2TokenAddress: string, chainId: number): L1Token {
  // @dev This might give false positives if tokens on different networks have the same address. I'm not sure how
  // to get around this...
  const tokenObject = Object.values(TOKEN_SYMBOLS_MAP).find(({ addresses }) => addresses[chainId] === l2TokenAddress);
  if (!tokenObject) {
    throw new Error(
      `TokenUtils#getTokenInfo: Unable to resolve token in TOKEN_SYMBOLS_MAP for ${l2TokenAddress} on chain ${chainId}`
    );
  }
  return {
    address: l2TokenAddress,
    symbol: tokenObject.symbol,
    decimals: tokenObject.decimals,
  };
}

/**
 * Get the USDC symbol for the given token address and chain ID.
 * @param l2Token A Web3 token address (not case sensitive)
 * @param chainId A chain Id to reference
 * @returns Either USDC (if native) or USDbC/USDC.e (if bridged) or undefined if the token address is not recognized.
 */
export function getUsdcSymbol(l2Token: string, chainId: number): string | undefined {
  const compareToken = (token?: string) => isDefined(token) && compareAddressesSimple(l2Token, token);
  return ["USDC", "USDbC", "USDC.e"].find((token) =>
    compareToken(
      (TOKEN_SYMBOLS_MAP as Record<string, { addresses?: Record<number, string> }>)[token]?.addresses?.[chainId]
    )
  );
}

export function getL1TokenInfo(l2TokenAddress: string, chainId: number): L1Token {
  const tokenObject = Object.values(TOKEN_SYMBOLS_MAP).find(({ addresses }) => addresses[chainId] === l2TokenAddress);
  const l1TokenAddress = tokenObject?.addresses[CHAIN_IDs.MAINNET];
  if (!l1TokenAddress) {
    throw new Error(
      `TokenUtils#getL1TokenInfo: Unable to resolve l1 token address in TOKEN_SYMBOLS_MAP for L2 token ${l2TokenAddress} on chain ${chainId}`
    );
  }
  return {
    address: l1TokenAddress,
    symbol: tokenObject.symbol,
    decimals: tokenObject.decimals,
  };
}
