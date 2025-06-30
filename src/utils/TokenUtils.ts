import assert from "assert";
import { BlockTag } from "@ethersproject/abstract-provider";
import { Contract, providers, Signer } from "ethers";
import * as constants from "../constants";
import { L1TokenInfo, TokenInfo } from "../interfaces";
import { ERC20__factory } from "../typechain";
import { BigNumber } from "./BigNumberUtils";
import { getNetworkName, chainIsL1, chainIsProd } from "./NetworkUtils";
import { isDefined } from "./TypeGuards";
import { Address, EvmAddress, toAddressType } from "./AddressUtils";
const { TOKEN_SYMBOLS_MAP, CHAIN_IDs, TOKEN_EQUIVALENCE_REMAPPING } = constants;

type SignerOrProvider = providers.Provider | Signer;

export async function fetchTokenInfo(address: string, signerOrProvider: SignerOrProvider): Promise<L1TokenInfo> {
  const token = new Contract(address, ERC20__factory.abi, signerOrProvider);
  const [symbol, decimals] = await Promise.all([token.symbol(), token.decimals()]);
  return { address: EvmAddress.from(address), symbol, decimals };
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
export function resolveSymbolOnChain(chainId: number, symbol: string): TokenInfo {
  // @dev Suppress tsc complaints by casting symbol to the expected type.
  const token = TOKEN_SYMBOLS_MAP[symbol as keyof typeof TOKEN_SYMBOLS_MAP];
  if (!isDefined(token) || !isDefined(token.addresses[chainId])) {
    const network = getNetworkName(chainId);
    throw new Error(`Unable to find token ${symbol} on ${network} (chain ID ${chainId}`);
  }

  const { decimals, addresses } = token;
  const address = toAddressType(addresses[chainId], chainId);
  assert(address.isEVM() || address.isSVM());

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

export function getCoingeckoTokenIdByAddress(address: string, chainId: number): string {
  const token = getTokenInfo(toAddressType(address, chainId), chainId);
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

export function isStablecoin(tokenSymbol: string): boolean {
  return constants.STABLE_COIN_SYMBOLS.some(
    (stablecoinSymbol) => stablecoinSymbol.toLowerCase() === tokenSymbol.toLowerCase()
  );
}

/**
 * @notice Returns the Token info for the token mapping in TOKEN_SYMBOLS_MAP matching the given l2TokenAddress
 * and chainId. If the chain is the hub chain, then will remap the L1 token to its equivalent L1 token symbol for example
 * it will always return a token info with symbol USDC and never USDC.e if chainId = mainnet.
 * @param l2Token Address instance.
 * @param chainId ChainId for l2Token address.
 * @param tokenMapping Optional custom token mapping.
 * @returns TokenInfo object.
 */
export function getTokenInfo(l2Token: Address, chainId: number, tokenMapping = TOKEN_SYMBOLS_MAP): TokenInfo {
  const address = l2Token.toNative();

  // @dev This might give false positives if tokens on different networks have the same address. I'm not sure how
  // to get around this...
  let tokenObject = Object.values(tokenMapping).find(({ addresses }) => addresses[chainId] === address);
  if (!tokenObject) {
    throw new Error(`Unable to resolve token info for ${address} on chain ${chainId}`);
  }
  if (chainIsL1(chainId)) {
    const l1TokenSymbol = TOKEN_EQUIVALENCE_REMAPPING[tokenObject.symbol] ?? tokenObject.symbol;
    tokenObject = tokenMapping[l1TokenSymbol as keyof typeof tokenMapping];
  }

  return { address: l2Token, symbol: tokenObject.symbol, decimals: tokenObject.decimals };
}

/**
 * Get the USDC symbol for the given token address and chain ID.
 * @param l2Token A Web3 token address (not case sensitive)
 * @param chainId A chain Id to reference
 * @returns Either USDC (if native) or USDbC/USDC.e (if bridged) or undefined if the token address is not recognized.
 */
export function getUsdcSymbol(l2Token: Address, chainId: number): string | undefined {
  type TokenRecord = Record<string, { addresses?: Record<number, string> }>;
  const IterableTokenSymbolsMap = TOKEN_SYMBOLS_MAP as TokenRecord;
  return ["USDC", "USDbC", "USDC.e"].find(
    (token) => IterableTokenSymbolsMap[token]?.addresses?.[chainId] === l2Token.toNative()
  );
}

/**
 * @notice Returns the l1 token address matching the given l2TokenAddress and chainId.
 */
export function getL1TokenAddress(l2TokenAddress: Address, chainId: number): EvmAddress {
  if (chainIsL1(chainId)) {
    assert(l2TokenAddress.isEVM());
    return l2TokenAddress;
  }

  const tokenObject = Object.values(TOKEN_SYMBOLS_MAP).find(({ addresses }) =>
    l2TokenAddress.toNative() === addresses[chainId]
  );
  const l1TokenAddress = tokenObject?.addresses[chainIsProd(chainId) ? CHAIN_IDs.MAINNET : CHAIN_IDs.SEPOLIA];
  if (!l1TokenAddress) {
    throw new Error(`getL1TokenAddress: Unable to resolve l1 token for L2 token ${l2TokenAddress} on chain ${chainId}`);
  }

  return EvmAddress.from(l1TokenAddress);
}
