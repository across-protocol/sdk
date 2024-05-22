import { BigNumber, Contract, providers, Signer, utils as ethersUtils } from "ethers";
import { getABI } from "./abi";

type Provider = providers.Provider;
type BlockTag = providers.BlockTag;
type Result = ethersUtils.Result;

export type Call3 = {
  contract: Contract;
  method: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  args?: any[];
};

// Multicall3 Constants:
export const multicall3Addresses: Record<number, string> = {
  1: "0xcA11bde05977b3631167028862bE2a173976CA11",
  10: "0xcA11bde05977b3631167028862bE2a173976CA11",
  137: "0xcA11bde05977b3631167028862bE2a173976CA11",
  324: "0xF9cda624FBC7e059355ce98a31693d299FACd963",
  8453: "0xcA11bde05977b3631167028862bE2a173976CA11",
  34443: "0xcA11bde05977b3631167028862bE2a173976CA11",
  42161: "0xcA11bde05977b3631167028862bE2a173976CA11",
  59144: "0xcA11bde05977b3631167028862bE2a173976CA11",
  534352: "0xcA11bde05977b3631167028862bE2a173976CA11",
  // Testnets
  5: "0xcA11bde05977b3631167028862bE2a173976CA11",
  300: "0xF9cda624FBC7e059355ce98a31693d299FACd963",
  59140: "0xcA11bde05977b3631167028862bE2a173976CA11",
  59141: "0xcA11bde05977b3631167028862bE2a173976CA11",
  80002: "0xcA11bde05977b3631167028862bE2a173976CA11",
  84531: "0xcA11bde05977b3631167028862bE2a173976CA11",
  84532: "0xcA11bde05977b3631167028862bE2a173976CA11",
  421613: "0xcA11bde05977b3631167028862bE2a173976CA11",
  534351: "0xcA11bde05977b3631167028862bE2a173976CA11",
  11155111: "0xcA11bde05977b3631167028862bE2a173976CA11",
  11155420: "0xcA11bde05977b3631167028862bE2a173976CA11",
};

export async function getMulticall3(
  chainId: number,
  signerOrProvider?: Signer | Provider
): Promise<Contract | undefined> {
  const address = multicall3Addresses[chainId];
  if (!address) {
    return undefined;
  }

  return new Contract(address, await getABI("Multicall3"), signerOrProvider);
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
