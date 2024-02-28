import { BlockTag } from "@ethersproject/abstract-provider";
import { BigNumber, Contract, providers, Signer } from "ethers";
import * as constants from "../constants";
import { L1Token } from "../interfaces";
import { ERC20__factory } from "../typechain";
import { getNetworkName } from "./NetworkUtils";
import { isDefined } from "./TypeGuards";
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
 * @param tokenMapping A parameter to determine where to source token information. Defaults to the constants-v2 variant.
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
