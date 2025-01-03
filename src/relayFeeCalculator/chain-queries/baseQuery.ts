import { L2Provider } from "@eth-optimism/sdk/dist/interfaces/l2-provider";
import { isL2Provider as isOptimismL2Provider } from "@eth-optimism/sdk/dist/l2-provider";

import { PopulatedTransaction, providers, VoidSigner } from "ethers";
import { Coingecko } from "../../coingecko";
import { CHAIN_IDs, DEFAULT_SIMULATED_RELAYER_ADDRESS } from "../../constants";
import { Deposit } from "../../interfaces";
import { SpokePool, SpokePool__factory } from "../../typechain";
import {
  BigNumberish,
  TransactionCostEstimate,
  populateV3Relay,
  BigNumber,
  toBNWei,
  bnZero,
  assert,
  chainIsOPStack,
} from "../../utils";
import { Logger, QueryInterface } from "../relayFeeCalculator";
import { Transport } from "viem";
import { getGasPriceEstimate } from "../../gasPriceOracle/oracle";
type Provider = providers.Provider;
type OptimismProvider = L2Provider<Provider>;
type SymbolMappingType = Record<
  string,
  {
    addresses: Record<number, string>;
    decimals: number;
  }
>;

/**
 * A unified QueryBase for querying gas costs, token prices, and decimals of various tokens
 * on a blockchain.
 */
export class QueryBase implements QueryInterface {
  readonly spokePool: SpokePool;
  /**
   * Instantiates a QueryBase instance
   * @param provider A valid Ethers.js provider
   * @param symbolMapping A mapping to valid ERC20 tokens and their respective characteristics
   * @param spokePoolAddress The valid address of the Spoke Pool deployment
   * @param simulatedRelayerAddress The address that these queries will reference as the sender. Note: This address must be approved for USDC
   * @param logger A logging utility to report logs
   * @param coingeckoProApiKey An optional CoinGecko API key that links to a PRO account
   * @param fixedGasPrice Overrides the gas price with a fixed value. Note: primarily used for the Boba blockchain
   * @param coingeckoBaseCurrency The basis currency that CoinGecko will use to resolve pricing
   */
  constructor(
    readonly provider: Provider | OptimismProvider,
    readonly symbolMapping: SymbolMappingType,
    readonly spokePoolAddress: string,
    readonly simulatedRelayerAddress: string,
    readonly logger: Logger,
    readonly coingeckoProApiKey?: string,
    readonly fixedGasPrice?: BigNumberish,
    readonly coingeckoBaseCurrency: string = "eth"
  ) {
    this.spokePool = SpokePool__factory.connect(spokePoolAddress, provider);
  }

  /**
   * Retrieves the current gas costs of performing a fillRelay contract at the referenced SpokePool.
   * @param deposit V3 deposit instance.
   * @param relayerAddress Relayer address to simulate with.
   * @param options
   * @param options.gasPrice Optional gas price to use for the simulation.
   * @param options.gasUnits Optional gas units to use for the simulation.
   * @param options.transport Optional transport object for custom gas price retrieval.
   * @returns The gas estimate for this function call (multiplied with the optional buffer).
   */
  async getGasCosts(
    deposit: Deposit,
    relayer = DEFAULT_SIMULATED_RELAYER_ADDRESS,
    options: Partial<{
      gasPrice: BigNumberish;
      gasUnits: BigNumberish;
      baseFeeMultiplier: BigNumber;
      transport: Transport;
    }> = {}
  ): Promise<TransactionCostEstimate> {
    const { gasPrice = this.fixedGasPrice, gasUnits, baseFeeMultiplier, transport } = options;

    const tx = await populateV3Relay(this.spokePool, deposit, relayer);
    const {
      nativeGasCost,
      tokenGasCost,
      gasPrice: impliedGasPrice,
    } = await this.estimateGas(tx, relayer, this.provider, {
      gasPrice,
      gasUnits,
      baseFeeMultiplier,
      transport,
    });

    return {
      nativeGasCost,
      tokenGasCost,
      gasPrice: impliedGasPrice,
    };
  }

  /**
   * Estimates the total gas cost required to submit an unsigned (populated) transaction on-chain.
   * @param unsignedTx The unsigned transaction that this function will estimate.
   * @param senderAddress The address that the transaction will be submitted from.
   * @param provider A valid ethers provider - will be used to reason the gas price.
   * @param options
   * @param options.gasPrice A manually provided gas price - if set, this function will not resolve the current gas price.
   * @param options.gasUnits A manually provided gas units - if set, this function will not estimate the gas units.
   * @param options.transport A custom transport object for custom gas price retrieval.
   * @returns Estimated cost in units of gas and the underlying gas token (gasPrice * estimatedGasUnits).
   */
  async estimateGas(
    unsignedTx: PopulatedTransaction,
    senderAddress: string,
    provider: providers.Provider | L2Provider<providers.Provider>,
    options: Partial<{
      gasPrice: BigNumberish;
      gasUnits: BigNumberish;
      baseFeeMultiplier: BigNumber;
      transport: Transport;
    }> = {}
  ): Promise<TransactionCostEstimate> {
    const { gasPrice: _gasPrice, gasUnits, baseFeeMultiplier = toBNWei("1"), transport } = options || {};

    const { chainId } = await provider.getNetwork();
    const voidSigner = new VoidSigner(senderAddress, provider);

    // Estimate the Gas units required to submit this transaction.
    const queries = [
      gasUnits ? Promise.resolve(BigNumber.from(gasUnits)) : voidSigner.estimateGas(unsignedTx),
      _gasPrice
        ? Promise.resolve({ maxFeePerGas: _gasPrice })
        : getGasPriceEstimate(provider, { chainId, baseFeeMultiplier, transport, unsignedTx }),
    ] as const;
    const [nativeGasCost, { maxFeePerGas: gasPrice }] = await Promise.all(queries);
    assert(nativeGasCost.gt(bnZero), "Gas cost should not be 0");
    let tokenGasCost: BigNumber;

    // OP stack is a special case; gas cost is computed by the SDK, without having to query price.
    if (chainIsOPStack(chainId)) {
      assert(isOptimismL2Provider(provider), `Unexpected provider for chain ID ${chainId}.`);
      const populatedTransaction = await voidSigner.populateTransaction({
        ...unsignedTx,
        gasLimit: nativeGasCost, // prevents additional gas estimation call
      });
      const l1GasCost = await provider.estimateL1GasCost(populatedTransaction);
      const l2GasCost = nativeGasCost.mul(gasPrice);
      tokenGasCost = l1GasCost.add(l2GasCost);
    } else {
      tokenGasCost = nativeGasCost.mul(gasPrice);
    }

    return {
      nativeGasCost, // Units: gas
      tokenGasCost, // Units: wei (nativeGasCost * wei/gas)
      gasPrice: tokenGasCost.div(nativeGasCost), // Units: wei/gas
    };
  }

  /**
   * Retrieves the current price of a token
   * @param tokenSymbol A valid [CoinGecko-ID](https://api.coingecko.com/api/v3/coins/list)
   * @returns The resolved token price within the specified coingeckoBaseCurrency
   */
  async getTokenPrice(tokenSymbol: string): Promise<number> {
    if (!this.symbolMapping[tokenSymbol]) throw new Error(`${tokenSymbol} does not exist in mapping`);
    const coingeckoInstance = Coingecko.get(this.logger, this.coingeckoProApiKey);
    const [, price] = await coingeckoInstance.getCurrentPriceByContract(
      this.symbolMapping[tokenSymbol].addresses[CHAIN_IDs.MAINNET],
      this.coingeckoBaseCurrency
    );
    return price;
  }

  /**
   * Resolves the number of decimal places a token can have
   * @param tokenSymbol A valid Across-Enabled Token ID
   * @returns The number of decimals of precision for the corresponding tokenSymbol
   */
  getTokenDecimals(tokenSymbol: string): number {
    if (!this.symbolMapping[tokenSymbol]) throw new Error(`${tokenSymbol} does not exist in mapping`);
    return this.symbolMapping[tokenSymbol].decimals;
  }
}
