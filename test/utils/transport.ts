import { custom } from "viem";
import { BigNumber, parseUnits } from "../../src/utils";

export const makeCustomTransport = (
  params: Partial<{ stdLastBaseFeePerGas: BigNumber; stdMaxPriorityFeePerGas: BigNumber }> = {}
) => {
  const { stdLastBaseFeePerGas = parseUnits("12", 9), stdMaxPriorityFeePerGas = parseUnits("1", 9) } = params;
  const stdMaxFeePerGas = stdLastBaseFeePerGas.add(stdMaxPriorityFeePerGas);
  const stdGasPrice = stdMaxFeePerGas;

  return custom({
    // eslint-disable-next-line require-await
    async request({ method }: { method: string; params: unknown }) {
      switch (method) {
        case "eth_gasPrice":
          return BigInt(stdGasPrice.toString());
        case "eth_getBlockByNumber":
          return { baseFeePerGas: BigInt(stdLastBaseFeePerGas.toString()) };
        case "eth_maxPriorityFeePerGas":
          return BigInt(stdMaxPriorityFeePerGas.toString());
        default:
          throw new Error(`Unsupported method: ${method}.`);
      }
    },
  });
};
