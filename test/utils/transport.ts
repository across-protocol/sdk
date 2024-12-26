import { custom } from "viem";
import { BigNumber, parseUnits } from "../../src/utils";

export const makeCustomTransport = (
  feeParams: Partial<{ stdLastBaseFeePerGas: BigNumber; stdMaxPriorityFeePerGas: BigNumber }> = {}
) => {
  const { stdLastBaseFeePerGas = parseUnits("12", 9), stdMaxPriorityFeePerGas = parseUnits("1", 9) } = feeParams;
  const stdMaxFeePerGas = stdLastBaseFeePerGas.add(stdMaxPriorityFeePerGas);
  const stdGasPrice = stdMaxFeePerGas;

  return custom({
    // eslint-disable-next-line require-await
    async request({ method, params }: { method: string; params: unknown[] }) {
      switch (method) {
        case "eth_gasPrice":
          return BigInt(stdGasPrice.toString());
        case "eth_getBlockByNumber":
          return { baseFeePerGas: BigInt(stdLastBaseFeePerGas.toString()) };
        case "eth_maxPriorityFeePerGas":
          return BigInt(stdMaxPriorityFeePerGas.toString());
        case "linea_estimateGas":
          // For testing purposes, double the priority fee if txnData is not the empty string "0x"
          return {
            // Linea base fee is always 7 wei
            baseFeePerGas: BigInt(7),
            priorityFeePerGas: BigInt(
              stdMaxPriorityFeePerGas
                .mul((params as { data: string }[])[0]?.data?.slice(2).length > 0 ? 2 : 1)
                .toString()
            ),
            gasLimit: BigInt("0"),
          };
        default:
          throw new Error(`Unsupported method: ${method}.`);
      }
    },
  });
};
