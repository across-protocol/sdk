import assert from "assert";
import { PopulatedTransaction, providers, VoidSigner } from "ethers";
import { TronWeb } from "tronweb";
import { getGasPriceEstimate, GasPriceEstimateOptions } from "../../gasPriceOracle";
import { TvmGasPriceEstimate } from "../../gasPriceOracle/types";
import { RelayData } from "../../interfaces";
import { Address, BigNumber, BigNumberish, bnZero, EvmAddress, TransactionCostEstimate } from "../../utils";
import { arch } from "../..";
import { Logger } from "../relayFeeCalculator";
import { QueryBase, SymbolMappingType } from "./baseQuery";

/**
 * A TVM-specific query implementation for TRON.
 *
 * TRON's JSON-RPC is EVM-compatible for reads and gas estimation, so this
 * class extends QueryBase and overrides only the gas price oracle dispatch
 * to use TronWeb (energy/bandwidth pricing) instead of the EVM oracle.
 *
 * The ethers provider is derived from the TronWeb instance's fullNode URL.
 */
export class TvmQuery extends QueryBase {
  readonly tronWeb: TronWeb;

  constructor(
    tronWeb: TronWeb,
    symbolMapping: SymbolMappingType,
    spokePoolAddress: string,
    simulatedRelayerAddress: EvmAddress,
    logger: Logger,
    coingeckoProApiKey?: string,
    fixedGasPrice?: BigNumberish,
    coingeckoBaseCurrency: string = "eth"
  ) {
    const provider = new providers.StaticJsonRpcProvider(tronWeb.fullNode.host);
    super(
      provider,
      symbolMapping,
      spokePoolAddress,
      simulatedRelayerAddress,
      logger,
      coingeckoProApiKey,
      fixedGasPrice,
      coingeckoBaseCurrency
    );
    this.tronWeb = tronWeb;
  }

  /**
   * Estimate the gas cost of a transaction using TVM energy pricing.
   *
   * Gas units (energy) are estimated via the ethers provider (TRON's JSON-RPC
   * returns energy units for eth_estimateGas). The energy price is queried
   * from TronWeb's gas price oracle.
   */
  override async estimateGas(
    unsignedTx: PopulatedTransaction,
    senderAddress: Address,
    provider: providers.Provider,
    options: Partial<
      GasPriceEstimateOptions & {
        gasPrice: BigNumberish;
        gasUnits: BigNumberish;
      }
    > = {}
  ): Promise<TransactionCostEstimate> {
    const { gasPrice: _gasPrice, gasUnits } = options;

    const voidSigner = new VoidSigner(senderAddress.toEvmAddress(), provider);

    const [nativeGasCost, gasPriceEstimate] = await Promise.all([
      gasUnits ? Promise.resolve(BigNumber.from(gasUnits)) : voidSigner.estimateGas(unsignedTx),
      _gasPrice
        ? Promise.resolve({ energyPrice: BigNumber.from(_gasPrice.toString()), bandwidthPrice: bnZero })
        : getGasPriceEstimate(this.tronWeb),
    ]);

    assert(nativeGasCost.gt(bnZero), "Gas cost should not be 0");

    const gasPrice = (gasPriceEstimate as TvmGasPriceEstimate).energyPrice;
    const tokenGasCost = nativeGasCost.mul(gasPrice);

    return { nativeGasCost, tokenGasCost, gasPrice };
  }

  override getAuxiliaryNativeTokenCost(deposit: RelayData): BigNumber {
    return arch.tvm.getAuxiliaryNativeTokenCost(deposit);
  }
}
