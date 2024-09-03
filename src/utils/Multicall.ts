import { BigNumber, Contract, providers, Signer, utils as ethersUtils } from "ethers";
import { CHAIN_IDs } from "@across-protocol/constants";
import { Multicall3, Multicall3__factory } from "./abi/typechain";

type Provider = providers.Provider;
type BlockTag = providers.BlockTag;
type Result = ethersUtils.Result;

export type Call3 = {
  contract: Contract;
  method: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  args?: any[];
};

const DETERMINISTIC_MULTICALL_ADDRESS = "0xcA11bde05977b3631167028862bE2a173976CA11";

const NON_DETERMINISTIC_MULTICALL_ADDRESSES = {
  [CHAIN_IDs.ZK_SYNC]: "0xF9cda624FBC7e059355ce98a31693d299FACd963",
};

const DETERMINISTIC_MULTICALL_CHAINS = [
  CHAIN_IDs.ARBITRUM,
  CHAIN_IDs.BASE,
  CHAIN_IDs.BLAST,
  CHAIN_IDs.BOBA,
  CHAIN_IDs.LINEA,
  CHAIN_IDs.LISK,
  CHAIN_IDs.MAINNET,
  CHAIN_IDs.MODE,
  CHAIN_IDs.OPTIMISM,
  CHAIN_IDs.POLYGON,
  CHAIN_IDs.REDSTONE,
  CHAIN_IDs.SCROLL,
  CHAIN_IDs.ZORA,
  // Testnet:
  CHAIN_IDs.BASE_SEPOLIA,
  CHAIN_IDs.BLAST_SEPOLIA,
  CHAIN_IDs.POLYGON_AMOY,
  CHAIN_IDs.SCROLL_SEPOLIA,
  CHAIN_IDs.SEPOLIA,
];

export function getMulticallAddress(chainId: number): string | undefined {
  if (DETERMINISTIC_MULTICALL_CHAINS.includes(chainId)) {
    return DETERMINISTIC_MULTICALL_ADDRESS;
  }
  return NON_DETERMINISTIC_MULTICALL_ADDRESSES[chainId];
}

export function getMulticall3(chainId: number, signerOrProvider: Signer | Provider): Multicall3 | undefined {
  const address = getMulticallAddress(chainId);
  if (!address) {
    return undefined;
  }

  return Multicall3__factory.connect(address, signerOrProvider);
}

export async function aggregate(multicall3: Contract, calls: Call3[], blockTag?: BlockTag): Promise<Result[]> {
  const inputs = calls.map(({ contract, method, args }) => ({
    target: contract.address,
    callData: contract.interface.encodeFunctionData(method, args),
  }));

  const [, results] = await (multicall3.callStatic.aggregate(inputs, { blockTag }) as Promise<[BigNumber, string[]]>);

  return results.map((result, idx) => {
    const { contract, method } = calls[idx];
    return contract.interface.decodeFunctionResult(method, result);
  });
}
