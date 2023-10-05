import * as constants from "../constants";
import { BigNumber, Contract, providers, Signer } from "ethers";
import { L1Token } from "../interfaces";
import { ERC20__factory } from "../typechain";
const { TOKEN_SYMBOLS_MAP, CHAIN_IDs } = constants;

type SignerOrProvider = providers.Provider | Signer;

export async function fetchTokenInfo(address: string, signerOrProvider: SignerOrProvider): Promise<L1Token> {
  const token = new Contract(address, ERC20__factory.abi, signerOrProvider);
  const [symbol, decimals] = await Promise.all([token.symbol(), token.decimals()]);
  return { address, symbol, decimals };
}

export const getL2TokenAddresses = (l1TokenAddress: string): { [chainId: number]: string } | undefined => {
  return Object.values(TOKEN_SYMBOLS_MAP).find((details) => {
    return details.addresses[CHAIN_IDs.MAINNET] === l1TokenAddress;
  })?.addresses;
};

/**
 * Returns the contract address for a given token symbol and chainId.
 * @param symbol A case-insensitive token symbol.
 * @param chainId The chainId to resolve the contract address for.
 * @returns The contract address for the given token symbol and chainId, or undefined if the token symbol is not supported.
 */
export const resolveContractFromSymbol = (symbol: string, chainId: string): string | undefined => {
  return Object.values(TOKEN_SYMBOLS_MAP).find((details) => {
    return details.symbol.toLowerCase() === symbol.toLowerCase();
  })?.addresses[Number(chainId)];
};

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
  blockTag: number | "latest" = "latest"
): Promise<BigNumber> {
  const token = ERC20__factory.connect(tokenAddress, signerOrProvider);
  return token.balanceOf(address, { blockTag });
}
