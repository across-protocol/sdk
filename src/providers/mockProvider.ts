import { BigNumber, providers } from "ethers";
import { Block, BlockTag, FeeData, TransactionResponse } from "@ethersproject/abstract-provider";
import { bnZero } from "../utils/BigNumberUtils";
import { CrosschainProvider } from "./";

/**
 * @notice Class used to test GasPriceOracle which makes ethers provider calls to the following implemented
 * methods.
 */
export class MockedProvider extends providers.StaticJsonRpcProvider implements CrosschainProvider {
  private transactions: { [hash: string]: TransactionResponse } = {};

  constructor(
    readonly stdLastBaseFeePerGas: BigNumber,
    readonly stdMaxPriorityFeePerGas: BigNumber,
    readonly defaultChainId = 1
  ) {
    super(undefined, defaultChainId);
  }

  getBlock(_blockHashOrBlockTag: BlockTag | string | Promise<BlockTag | string>): Promise<Block> {
    const mockBlock: Block = {
      transactions: [],
      hash: "0x",
      parentHash: "0x",
      number: 0,
      nonce: "0",
      difficulty: 0,
      _difficulty: bnZero,
      timestamp: 0,
      gasLimit: bnZero,
      gasUsed: bnZero,
      baseFeePerGas: this.stdLastBaseFeePerGas,
      miner: "0x",
      extraData: "0x",
    };
    return Promise.resolve(mockBlock);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  send(method: string, _params: Array<any>): Promise<any> {
    switch (method) {
      case "eth_maxPriorityFeePerGas":
        return Promise.resolve(this.stdMaxPriorityFeePerGas);
      default:
        throw new Error(`MockedProvider#Unimplemented method: ${method}`);
    }
  }

  getFeeData(): Promise<FeeData> {
    return Promise.resolve({
      lastBaseFeePerGas: this.stdLastBaseFeePerGas,
      maxPriorityFeePerGas: this.stdMaxPriorityFeePerGas,
      // Following fields unused in GasPrice oracle
      maxFeePerGas: null,
      gasPrice: null,
    });
  }

  getTransaction(hash: string): Promise<TransactionResponse> {
    return Promise.resolve(this.transactions[hash]);
  }

  getGasPrice(): Promise<BigNumber> {
    return Promise.resolve(this.stdLastBaseFeePerGas.add(this.stdMaxPriorityFeePerGas));
  }

  getNetwork(): Promise<{ chainId: number; name: string }> {
    return Promise.resolve({
      name: "mocknetwork",
      chainId: this.defaultChainId,
    });
  }

  getNetworkId(): Promise<number> {
    return Promise.resolve(this.defaultChainId);
  }

  _setTransaction(hash: string, transaction: TransactionResponse) {
    this.transactions[hash] = transaction;
  }
}
