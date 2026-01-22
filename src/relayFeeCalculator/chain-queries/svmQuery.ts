import assert from "assert";
import {
  TransactionSigner,
  fetchEncodedAccount,
  isSome,
  Rpc,
  pipe,
  appendTransactionMessageInstruction,
  compileTransaction,
  getBase64EncodedWireTransaction,
  type Instruction,
} from "@solana/kit";
import {
  SVMProvider,
  SolanaVoidSigner,
  getFillRelayTx,
  getIPFillRelayTx,
  getFillRelayViaInstructionParamsInstructions,
  toAddress,
  createDefaultTransaction,
  getAssociatedTokenAddress,
  isSVMFillTooLarge,
  SolanaTransaction,
} from "../../arch/svm";
import { JitoInterface } from "../../providers/solana";
import { Coingecko } from "../../coingecko";
import { CHAIN_IDs } from "../../constants";
import { getGasPriceEstimate } from "../../gasPriceOracle";
import { RelayData } from "../../interfaces";
import { Address, BigNumber, BigNumberish, SvmAddress, TransactionCostEstimate, toBN, mapAsync } from "../../utils";
import { Logger, QueryInterface, getDefaultRelayer } from "../relayFeeCalculator";
import { SymbolMappingType } from "./";
import { TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import { TOKEN_2022_PROGRAM_ADDRESS, getTokenSize, fetchMint, Extension } from "@solana-program/token-2022";
import { getSetComputeUnitLimitInstruction, estimateComputeUnitLimitFactory } from "@solana-program/compute-budget";
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
    this.computeUnitEstimator = estimateComputeUnitLimitFactory({
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

    // For solana, we algorithmically estimate gas based on the size of the message.
    const _fillRelayTx = await this.getFillRelayTx(
      { ...relayData, recipient, outputToken, exclusiveRelayer },
      SolanaVoidSigner(relayer.toBase58()),
      repaymentChainId,
      repaymentAddress
    );

    const fillTooLarge = isSVMFillTooLarge(_fillRelayTx);
    // If the fill is too large, we need to construct a dummy fill relay transaction which estimates the priority fee of the fillRelay instruction call. To guarantee
    // that the transaction won't be too large, we overwrite the message with empty bytes.
    const fillRelayTx = fillTooLarge.tooLarge
      ? await this.getFillRelayTx(
          { ...relayData, recipient, outputToken, exclusiveRelayer, message: "0x" },
          SolanaVoidSigner(relayer.toBase58()),
          repaymentChainId,
          repaymentAddress
        )
      : _fillRelayTx;

    const [_computeUnitsConsumed, gasPriceEstimate, tokenAccountInfo] = await Promise.all([
      fillTooLarge.tooLarge
        ? this.estimateComputeUnits(
            { ...relayData, recipient, outputToken, exclusiveRelayer },
            relayer,
            repaymentChainId,
            repaymentAddress
          )
        : this.computeUnitEstimator(fillRelayTx),
      getGasPriceEstimate(this.provider, {
        unsignedTx: fillRelayTx,
        baseFeeMultiplier: options.baseFeeMultiplier,
        priorityFeeMultiplier: options.priorityFeeMultiplier,
      }),
      this.provider.getAccountInfo(toAddress(outputToken), { encoding: "base58" }).send(),
    ]);
    const computeUnitsConsumed = toBN(_computeUnitsConsumed);

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
  ): Promise<SolanaTransaction> {
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

  // The fill is too large; we need to simulate the transaction in a bundle.
  async estimateComputeUnits(
    relayData: RelayData & {
      destinationChainId: number;
      recipient: SvmAddress;
      outputToken: SvmAddress;
      exclusiveRelayer: SvmAddress;
    },
    relayer: SvmAddress,
    repaymentChainId: number,
    repaymentAddress: SvmAddress
  ): Promise<bigint> {
    // @dev There is no way to tell if the RPC supports the JITO interface without querying the rpc directly.
    // Cast the rpc type to support JITO and attempt to call `simulateBundle`. Throw and error if it fails, since
    // the transaction message cannot be simulated otherwise.
    const provider = this.provider as Rpc<JitoInterface>;

    const spokePoolAddr = toAddress(this.spokePool);
    const voidSigner = SolanaVoidSigner(relayer.toBase58());

    const [instructionParamsIxs, _fillRelayTx] = await Promise.all([
      getFillRelayViaInstructionParamsInstructions(
        spokePoolAddr,
        relayData,
        repaymentChainId,
        repaymentAddress,
        voidSigner,
        provider
      ),
      getIPFillRelayTx(this.spokePool, provider, relayData, voidSigner, repaymentChainId, repaymentAddress),
    ]);

    // Set a high compute unit limit for the fill relay transaction so that the simulation won't fail because
    // it ran out of CUs.
    const computeUnitLimitIx = getSetComputeUnitLimitInstruction({ units: 10_000_000 });
    const fillRelayTx = pipe(_fillRelayTx, (tx) => appendTransactionMessageInstruction(computeUnitLimitIx, tx));

    const instructionParamsTxs = await mapAsync(instructionParamsIxs, async (ix: Instruction) => {
      return pipe(await createDefaultTransaction(provider, voidSigner), (tx) =>
        appendTransactionMessageInstruction(ix, tx)
      );
    });
    const bundleTxns = [...instructionParamsTxs, fillRelayTx].map((txn) => {
      const compiled = compileTransaction(txn);
      return getBase64EncodedWireTransaction(compiled);
    });

    // Define execution accounts for the relayer simulation.
    const executionAccounts = bundleTxns.map(() => {
      return { accountIndex: 0, addresses: [this.spokePool.toBase58(), relayer.toBase58()] };
    });
    const simulateBundleResponse = await provider
      .simulateBundle(
        {
          encodedTransactions: bundleTxns,
        },
        {
          skipSigVerify: true,
          preExecutionAccountsConfigs: executionAccounts,
          postExecutionAccountsConfigs: executionAccounts,
        }
      )
      .send();

    // If the bundle simulation failed, then return data from the failure.
    if (simulateBundleResponse.value.summary !== "succeeded") {
      const { TransactionFailure: failure } = simulateBundleResponse.value.summary.failed.error;
      throw new Error(`simulateBundle failed with result: ${failure[1]}`);
    }

    const totalCuSpent = simulateBundleResponse.value.transactionResults.reduce(
      (sum, res) => res.unitsConsumed + sum,
      BigInt(0)
    );
    return totalCuSpent;
  }
}
