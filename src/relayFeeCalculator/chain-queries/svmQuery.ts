import assert from "assert";
import {
  getComputeUnitEstimateForTransactionMessageFactory,
  TransactionSigner,
  fetchEncodedAccount,
  isSome,
} from "@solana/kit";
import { SVMProvider, SolanaVoidSigner, getFillRelayTx, toAddress, getAssociatedTokenAddress } from "../../arch/svm";
import { Coingecko } from "../../coingecko";
import { CHAIN_IDs } from "../../constants";
import { getGasPriceEstimate } from "../../gasPriceOracle";
import { RelayData } from "../../interfaces";
import { Address, BigNumber, BigNumberish, SvmAddress, TransactionCostEstimate, toBN } from "../../utils";
import { Logger, QueryInterface, getDefaultRelayer } from "../relayFeeCalculator";
import { SymbolMappingType } from "./";
import { TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import { TOKEN_2022_PROGRAM_ADDRESS, getTokenSize, fetchMint, Extension } from "@solana-program/token-2022";
import { arch } from "../..";

/**
 * A special QueryBase implementation for SVM used for querying gas costs, token prices, and decimals of various tokens
 * on Solana.
 */
export class SvmQuery implements QueryInterface {
  protected computeUnitEstimator;

  /**
   * Instantiates a SvmQuery instance
   * @param provider A valid solana/kit rpc client.
   * @param symbolMapping A mapping to valid ERC20 tokens and their respective characteristics
   * @param spokePool The valid address of the Spoke Pool deployment
   * @param simulatedRelayerAddress The address that these queries will reference as the sender. Note: This address must be approved for USDC
   * @param logger A logging utility to report logs
   * @param coingeckoProApiKey An optional CoinGecko API key that links to a PRO account
   * @param fixedGasPrice Overrides the gas price with a fixed value. Note: primarily used for the Boba blockchain
   * @param coingeckoBaseCurrency The basis currency that CoinGecko will use to resolve pricing
   */
  constructor(
    readonly provider: SVMProvider,
    readonly symbolMapping: SymbolMappingType,
    readonly spokePool: SvmAddress,
    readonly simulatedRelayerAddress: SvmAddress,
    readonly logger: Logger,
    readonly coingeckoProApiKey?: string,
    readonly fixedGasPrice?: BigNumberish,
    readonly coingeckoBaseCurrency: string = "eth"
  ) {
    this.computeUnitEstimator = getComputeUnitEstimateForTransactionMessageFactory({
      rpc: provider,
    });
  }

  /**
   * Retrieves the current gas costs of performing a fillRelay contract at the referenced SpokePool.
   * @param relayData RelayData instance, supplemented with destinationChainId
   * @param _relayer Relayer address to simulate with.
   * @param options
   * @param options.gasPrice Optional gas price to use for the simulation.
   * @param options.gasUnits Optional gas units to use for the simulation.
   * @param options.transport Optional transport object for custom gas price retrieval.
   * @returns The gas estimate for this function call (multiplied with the optional buffer).
   */
  async getGasCosts(
    relayData: RelayData & { destinationChainId: number },
    relayer = getDefaultRelayer(relayData.destinationChainId),
    options: Partial<{
      gasPrice: BigNumberish;
      gasUnits: BigNumberish;
      baseFeeMultiplier: BigNumber;
      priorityFeeMultiplier: BigNumber;
    }> = {}
  ): Promise<TransactionCostEstimate> {
    const { destinationChainId, recipient, outputToken, exclusiveRelayer } = relayData;
    assert(recipient.isSVM(), `getGasCosts: recipient not an SVM address (${recipient})`);
    assert(outputToken.isSVM(), `getGasCosts: outputToken not an SVM address (${outputToken})`);
    assert(exclusiveRelayer.isSVM(), `getGasCosts: exclusiveRelayer not an SVM address (${exclusiveRelayer})`);
    assert(relayer.isSVM());

    const [repaymentChainId, repaymentAddress] = [destinationChainId, relayer]; // These are not important for gas cost simulation.
    const fillRelayTx = await this.getFillRelayTx(
      { ...relayData, recipient, outputToken, exclusiveRelayer },
      SolanaVoidSigner(relayer.toBase58()),
      repaymentChainId,
      repaymentAddress
    );

    const [computeUnitsConsumed, gasPriceEstimate, tokenAccountInfo] = await Promise.all([
      toBN(await this.computeUnitEstimator(fillRelayTx)),
      getGasPriceEstimate(this.provider, {
        unsignedTx: fillRelayTx,
        baseFeeMultiplier: options.baseFeeMultiplier,
        priorityFeeMultiplier: options.priorityFeeMultiplier,
      }),
      this.provider.getAccountInfo(toAddress(outputToken), { encoding: "base58" }).send(),
    ]);

    // If the owner of the token account is not the token program, then we can assume that it is the 2022 token program address, in which
    // case we need to determine the extensions the token has to properly calculate rent exemption.
    const tokenOwner = tokenAccountInfo!.value!.owner;
    assert(
      tokenOwner === TOKEN_2022_PROGRAM_ADDRESS || tokenOwner === TOKEN_PROGRAM_ADDRESS,
      `${outputToken} has invalid token account owner ${tokenOwner}.`
    );
    const recipientAta = await getAssociatedTokenAddress(recipient, outputToken, tokenOwner);
    const encodedAta = await fetchEncodedAccount(this.provider, recipientAta);

    // We can cast the gas price estimate to an SvmGasPriceEstimate here since the oracle should always
    // query the Solana adapter.
    const gasPrice = gasPriceEstimate.baseFee.add(
      gasPriceEstimate.microLamportsPerComputeUnit.mul(computeUnitsConsumed).div(toBN(1_000_000)) // 1_000_000 microLamports/lamport.
    );
    let tokenGasCost = gasPrice;

    // If the ATA does not exist, we need to factor the rent amount into the token gas cost.
    if (!encodedAta.exists) {
      // If the ATA is a non-2022 token, then it will always have a fixed size of 165.
      let extensions: Extension[] | undefined = undefined;
      if (tokenOwner === TOKEN_2022_PROGRAM_ADDRESS) {
        const mint = await fetchMint(this.provider, toAddress(outputToken));
        extensions = isSome(mint.data.extensions) ? mint.data.extensions.value : undefined;
      }
      const tokenAccountSize = getTokenSize(extensions);
      const rentCostInLamports = await this.provider.getMinimumBalanceForRentExemption(BigInt(tokenAccountSize)).send();
      tokenGasCost = tokenGasCost.add(toBN(Number(rentCostInLamports)));
    }

    return {
      nativeGasCost: computeUnitsConsumed,
      tokenGasCost,
      gasPrice,
    };
  }

  /**
   * @notice Return the gas cost of a simulated transaction
   * @param fillRelayTx FillRelay transaction
   * @param relayer SVM address of the relayer
   * @returns Estimated gas cost in compute units
   */
  async getNativeGasCost(
    deposit: RelayData & { destinationChainId: number },
    relayer = getDefaultRelayer(deposit.destinationChainId)
  ): Promise<BigNumber> {
    const { destinationChainId, recipient, outputToken, exclusiveRelayer } = deposit;
    assert(recipient.isSVM(), `getNativeGasCost: recipient not an SVM address (${recipient})`);
    assert(outputToken.isSVM(), `getNativeGasCost: outputToken not an SVM address (${outputToken})`);
    assert(exclusiveRelayer.isSVM(), `getNativeGasCost: exclusiveRelayer not an SVM address (${exclusiveRelayer})`);
    assert(relayer.isSVM());

    const [repaymentChainId, repaymentAddress] = [destinationChainId, relayer]; // These are not important for gas cost simulation.
    const fillRelayTx = await this.getFillRelayTx(
      { ...deposit, recipient, outputToken, exclusiveRelayer },
      SolanaVoidSigner(relayer.toBase58()),
      repaymentChainId,
      repaymentAddress
    );
    return toBN(await this.computeUnitEstimator(fillRelayTx));
  }

  /**
   * @notice Return the native token cost of filling a deposit beyond gas cost. If `value_amount` is specified in a message,
   * `value_amount` of SOL gets forwarded to the first Account. We account for that in Fill cost estimation
   * @param deposit RelayData associated with Deposit we're estimating for
   * @throws If deposit.message is malformed (unable to be deserialized into `AcrossPlusMessage`)
   * @returns Native token cost
   */
  getAuxiliaryNativeTokenCost(deposit: RelayData): BigNumber {
    return arch.svm.getAuxiliaryNativeTokenCost(deposit);
  }

  /**
   * @notice Return the fillRelay transaction for a given deposit
   * @param relayData RelayData instance, supplemented with destinationChainId
   * @param relayer SVM address of the relayer
   * @returns FillRelay transaction
   */
  protected async getFillRelayTx(
    relayData: Omit<RelayData, "recipient" | "outputToken"> & {
      destinationChainId: number;
      recipient: SvmAddress;
      outputToken: SvmAddress;
    },
    signer: TransactionSigner,
    repaymentChainId: number,
    repaymentAddress: Address
  ) {
    return await getFillRelayTx(this.spokePool, this.provider, relayData, signer, repaymentChainId, repaymentAddress);
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
