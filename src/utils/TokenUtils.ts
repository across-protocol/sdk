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

export const resolveContractFromSymbol = (symbol: string, chainId: string): string | undefined => {
  return (
    TOKEN_SYMBOLS_MAP as Record<
      string,
      {
        name: string;
        symbol: string;
        decimals: number;
        addresses: {
          [x: number]: string;
        };
      }
    >
  )[symbol]?.addresses[Number(chainId)];
};
