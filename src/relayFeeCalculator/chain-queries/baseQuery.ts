import { L2Provider } from "@eth-optimism/sdk/dist/interfaces/l2-provider";
import { isL2Provider as isOptimismL2Provider } from "@eth-optimism/sdk/dist/l2-provider";
import { PopulatedTransaction, providers, VoidSigner } from "ethers";
import { Coingecko } from "../../coingecko";
import { CHAIN_IDs } from "../../constants";
import { RelayData } from "../../interfaces";
import { SpokePool, SpokePool__factory } from "../../typechain";
import { populateV3Relay } from "../../arch/evm";
import {
  BigNumberish,
  EvmAddress,
  TransactionCostEstimate,
  BigNumber,
  toBNWei,
  bnZero,
  chainIsOPStack,
  fixedPointAdjustment,
  toAddressType,
  Address,
} from "../../utils";
import assert from "assert";
import { Logger, QueryInterface, getDefaultSimulatedRelayerAddress } from "../relayFeeCalculator";
import { Transport } from "viem";
import { getGasPriceEstimate } from "../../gasPriceOracle";
import { EvmProvider } from "../../arch/evm/types";

export type SymbolMappingType = Record<
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
    readonly provider: EvmProvider,
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
   * @param relayData RelayData instance, supplemented with destinationChainId
   * @param relayerAddress Relayer address to simulate with.
   * @param options
   * @param options.gasPrice Optional gas price to use for the simulation.
   * @param options.gasUnits Optional gas units to use for the simulation.
   * @param options.transport Optional transport object for custom gas price retrieval.
   * @returns The gas estimate for this function call (multiplied with the optional buffer).
   */
  async getGasCosts(
    relayData: RelayData & { destinationChainId: number },
    relayer = toAddressType(getDefaultSimulatedRelayerAddress(relayData.destinationChainId), relayData.destinationChainId),
    options: Partial<{
      gasPrice: BigNumberish;
      gasUnits: BigNumberish;
      baseFeeMultiplier: BigNumber;
      priorityFeeMultiplier: BigNumber;
      opStackL1GasCostMultiplier: BigNumber;
      transport: Transport;
    }> = {}
  ): Promise<TransactionCostEstimate> {
    const {
      gasPrice = this.fixedGasPrice,
      gasUnits,
      baseFeeMultiplier,
      priorityFeeMultiplier,
      opStackL1GasCostMultiplier,
      transport,
    } = options;

    const { recipient, outputToken, exclusiveRelayer } = relayData;
    assert(recipient.isEVM(), `getGasCosts: recipient not an EVM address (${recipient})`);
    assert(outputToken.isEVM(), `getGasCosts: outputToken not an EVM address (${outputToken})`);
    assert(exclusiveRelayer.isEVM(), `getGasCosts: exclusiveRelayer not an EVM address (${exclusiveRelayer})`);

    const tx = await this.getUnsignedTxFromDeposit({ ...relayData, recipient, outputToken, exclusiveRelayer }, relayer);
    const {
      nativeGasCost,
      tokenGasCost,
      gasPrice: impliedGasPrice,
      opStackL1GasCost,
    } = await this.estimateGas(tx, relayer, this.provider, {
      gasPrice,
      gasUnits,
      baseFeeMultiplier,
      priorityFeeMultiplier,
      opStackL1GasCostMultiplier,
      transport,
    });

    return {
      nativeGasCost,
      tokenGasCost,
      gasPrice: impliedGasPrice,
      opStackL1GasCost,
    };
  }

  /**
   * @notice Return ethers.PopulatedTransaction for a fill based on input deposit args
   * @param relayData RelayData instance, supplemented with destinationChainId
   * @param relayer Sender of PopulatedTransaction
   * @returns PopulatedTransaction
   */
  getUnsignedTxFromDeposit(
    relayData: Omit<RelayData, "recipient" | "outputToken"> & {
      destinationChainId: number;
      recipient: EvmAddress;
      outputToken: EvmAddress;
    },
    relayer = toAddressType(getDefaultSimulatedRelayerAddress(relayData.destinationChainId), relayData.destinationChainId)
  ): Promise<PopulatedTransaction> {
    return populateV3Relay(this.spokePool, relayData, relayer);
  }

  /**
   * @notice Return the gas cost of a simulated transaction
   * @param relayData RelayData instance, supplemented with destinationChainId
   * @param relayer Sender of PopulatedTransaction
   * @returns Estimated gas cost based on ethers.VoidSigner's gas estimation
   */
  async getNativeGasCost(
    relayData: RelayData & { destinationChainId: number },
    relayer = toAddressType(getDefaultSimulatedRelayerAddress(relayData.destinationChainId), relayData.destinationChainId)
  ): Promise<BigNumber> {
    const { recipient, outputToken, exclusiveRelayer } = relayData;
    assert(recipient.isEVM(), `getNativeGasCost: recipient not an EVM address (${recipient})`);
    assert(outputToken.isEVM(), `getNativeGasCost: outputToken not an EVM address (${outputToken})`);
    assert(exclusiveRelayer.isEVM(), `getNativeGasCost: exclusiveRelayer not an EVM address (${exclusiveRelayer})`);

    const unsignedTx = await this.getUnsignedTxFromDeposit(
      { ...relayData, recipient, outputToken, exclusiveRelayer },
      relayer
    );
    const voidSigner = new VoidSigner(relayer.toEvmAddress(), this.provider);
    return voidSigner.estimateGas(unsignedTx);
  }

  /**
   * @notice Return L1 data fee for OP stack L2 transaction, which is based on L2 calldata.
   * @dev https://docs.optimism.io/stack/transactions/fees#l1-data-fee
   * @param unsignedTx L2 transaction that you want L1 data fee for
   * @param relayer Sender of unsignedTx
   * @param options Specify gas units to avoid additional gas estimation call and multiplier for L1 data fee
   * @returns BigNumber L1 data fee in gas units
   */
  async getOpStackL1DataFee(
    unsignedTx: PopulatedTransaction,
    relayer = toAddressType(getDefaultSimulatedRelayerAddress(unsignedTx.chainId), CHAIN_IDs.MAINNET),
    options: Partial<{
      opStackL2GasUnits: BigNumberish;
      opStackL1DataFeeMultiplier: BigNumber;
    }>
  ): Promise<BigNumber> {
    const { opStackL2GasUnits, opStackL1DataFeeMultiplier = toBNWei("1") } = options || {};
    const { chainId } = await this.provider.getNetwork();
    assert(isOptimismL2Provider(this.provider), `Unexpected provider for chain ID ${chainId}.`);
    const voidSigner = new VoidSigner(relayer.toEvmAddress(), this.provider);
    const populatedTransaction = await voidSigner.populateTransaction({
      ...unsignedTx,
      gasLimit: opStackL2GasUnits, // prevents additional gas estimation call
    });
    const l1DataFee = await (this.provider as L2Provider<providers.Provider>).estimateL1GasCost(populatedTransaction);
    return l1DataFee.mul(opStackL1DataFeeMultiplier).div(fixedPointAdjustment);
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
    senderAddress: Address,
    provider: providers.Provider | L2Provider<providers.Provider>,
    options: Partial<{
      gasPrice: BigNumberish;
      gasUnits: BigNumberish;
      baseFeeMultiplier: BigNumber;
      priorityFeeMultiplier: BigNumber;
      opStackL1GasCostMultiplier: BigNumber;
      transport: Transport;
    }> = {}
  ): Promise<TransactionCostEstimate> {
    const {
      gasPrice: _gasPrice,
      gasUnits,
      baseFeeMultiplier = toBNWei("1"),
      priorityFeeMultiplier = toBNWei("1"),
      opStackL1GasCostMultiplier = toBNWei("1"),
      transport,
    } = options || {};

    const { chainId } = await provider.getNetwork();
    const voidSigner = new VoidSigner(senderAddress.toEvmAddress(), provider);

    // Estimate the Gas units required to submit this transaction.
    const queries = [
      gasUnits ? Promise.resolve(BigNumber.from(gasUnits)) : voidSigner.estimateGas(unsignedTx),
      _gasPrice
        ? Promise.resolve({ maxFeePerGas: _gasPrice })
        : getGasPriceEstimate(provider, { chainId, baseFeeMultiplier, priorityFeeMultiplier, transport, unsignedTx }),
    ] as const;
    const [nativeGasCost, gasPriceEstimate] = await Promise.all(queries);

    const gasPrice = gasPriceEstimate.maxFeePerGas;
    assert(nativeGasCost.gt(bnZero), "Gas cost should not be 0");
    let tokenGasCost: BigNumber;

    // OP stack is a special case; gas cost is computed by the SDK, without having to query price.
    let opStackL1GasCost: BigNumber | undefined;
    if (chainIsOPStack(chainId)) {
      opStackL1GasCost = await this.getOpStackL1DataFee(unsignedTx, senderAddress, {
        opStackL2GasUnits: nativeGasCost,
        opStackL1DataFeeMultiplier: opStackL1GasCostMultiplier,
      });
      const l2GasCost = nativeGasCost.mul(gasPrice);
      tokenGasCost = opStackL1GasCost.add(l2GasCost);
    } else {
      tokenGasCost = nativeGasCost.mul(gasPrice);
    }

    return {
      nativeGasCost, // Units: gas
      tokenGasCost, // Units: wei (nativeGasCost * wei/gas)
      gasPrice: BigNumber.from(gasPrice.toString()), // Units: wei/gas, does not include l1GasCost for OP stack chains
      opStackL1GasCost,
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
}
