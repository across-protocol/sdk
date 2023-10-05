import * as constants from "../constants";
import { Contract, providers, Signer } from "ethers";
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
