import { pipe } from "@solana/functional";
import { Coingecko } from "../../coingecko";
import { SymbolMappingType } from "./";
import { CHAIN_IDs } from "../../constants";
import { Deposit } from "../../interfaces";
import { getGasPriceEstimate, SvmGasPriceEstimate } from "../../gasPriceOracle";
import {
  BigNumberish,
  TransactionCostEstimate,
  BigNumber,
  SvmAddress,
  toBN,
  isDefined,
  toAddressType,
} from "../../utils";
import { getDefaultSimulatedRelayerAddress, Logger, QueryInterface } from "../relayFeeCalculator";
import {
  fillRelayInstruction,
  createApproveInstruction,
  createTokenAccountsInstruction,
  SVMProvider,
  SolanaVoidSigner,
  getAssociatedTokenAddress,
} from "../../arch/svm";
import {
  createTransactionMessage,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  appendTransactionMessageInstructions,
  getComputeUnitEstimateForTransactionMessageFactory,
  fetchEncodedAccount,
  IInstruction,
} from "@solana/kit";
import { fetchMint, getCreateAssociatedTokenInstructionAsync } from "@solana-program/token";

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
   * @param spokePoolAddress The valid address of the Spoke Pool deployment
   * @param simulatedRelayerAddress The address that these queries will reference as the sender. Note: This address must be approved for USDC
   * @param logger A logging utility to report logs
   * @param coingeckoProApiKey An optional CoinGecko API key that links to a PRO account
   * @param fixedGasPrice Overrides the gas price with a fixed value. Note: primarily used for the Boba blockchain
   * @param coingeckoBaseCurrency The basis currency that CoinGecko will use to resolve pricing
   */
  constructor(
    readonly provider: SVMProvider,
    readonly symbolMapping: SymbolMappingType,
    readonly spokePoolAddress: SvmAddress,
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

  private formatDepositForSvm(deposit: Omit<Deposit, "messageHash">): Omit<Deposit, "messageHash"> {
    // Create a new object, effectively a deep clone for the structure.
    // BigNumber and other non-address fields are directly assigned (standard practice as they are often immutable or treated as such).
    const newDeposit: Omit<Deposit, "messageHash"> = {
      // RelayData fields
      originChainId: deposit.originChainId,
      depositor: toAddressType(deposit.depositor).forceSvmAddress().toBytes32(),
      recipient: toAddressType(deposit.recipient).forceSvmAddress().toBytes32(),
      depositId: deposit.depositId, // BigNumber, assign directly
      inputToken: toAddressType(deposit.inputToken).forceSvmAddress().toBytes32(),
      inputAmount: deposit.inputAmount, // BigNumber, assign directly
      outputToken: toAddressType(deposit.outputToken).forceSvmAddress().toBytes32(),
      outputAmount: deposit.outputAmount, // BigNumber, assign directly
      message: deposit.message,
      fillDeadline: deposit.fillDeadline,
      exclusiveRelayer: toAddressType(deposit.exclusiveRelayer).forceSvmAddress().toBytes32(),
      exclusivityDeadline: deposit.exclusivityDeadline,
      // Deposit specific fields
      destinationChainId: deposit.destinationChainId,
      quoteTimestamp: deposit.quoteTimestamp,
      speedUpSignature: deposit.speedUpSignature,
      // updatedRecipient is optional, handle it if present
      updatedRecipient: deposit.updatedRecipient
        ? toAddressType(deposit.updatedRecipient).forceSvmAddress().toBytes32()
        : undefined,
      updatedOutputAmount: deposit.updatedOutputAmount, // BigNumber, assign directly
      updatedMessage: deposit.updatedMessage,
      fromLiteChain: deposit.fromLiteChain,
      toLiteChain: deposit.toLiteChain,
    };
    return newDeposit;
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
    deposit: Omit<Deposit, "messageHash">,
    _relayer = getDefaultSimulatedRelayerAddress(deposit.destinationChainId),
    options: Partial<{
      gasPrice: BigNumberish;
      gasUnits: BigNumberish;
      baseFeeMultiplier: BigNumber;
      priorityFeeMultiplier: BigNumber;
    }> = {}
  ): Promise<TransactionCostEstimate> {
    const relayer = _relayer ? toAddressType(_relayer).forceSvmAddress() : this.simulatedRelayerAddress;

    const fillRelayTx = await this.getFillRelayTx(this.formatDepositForSvm(deposit), relayer.toBase58());

    console.log("[USER_LOG_getGasCosts] before computeUnitEstimator");
    console.log("[USER_LOG_getGasCosts] fillRelayTx ", fillRelayTx);
    const cu = await this.computeUnitEstimator(fillRelayTx);
    console.log("[USER_LOG_getGasCosts] after computeUnitEstimator");

    const [computeUnitsConsumed, _gasPriceEstimate] = await Promise.all([
      toBN(cu),
      getGasPriceEstimate(this.provider, {
        unsignedTx: fillRelayTx,
        baseFeeMultiplier: options.baseFeeMultiplier,
        priorityFeeMultiplier: options.priorityFeeMultiplier,
      }),
    ]);

    // We can cast the gas price estimate to an SvmGasPriceEstimate here since the oracle should always
    // query the Solana adapter.
    const gasPriceEstimate = _gasPriceEstimate as SvmGasPriceEstimate;
    const gasPrice = gasPriceEstimate.baseFee.add(
      gasPriceEstimate.microLamportsPerComputeUnit.mul(computeUnitsConsumed).div(toBN(1_000_000)) // 1_000_000 microLamports/lamport.
    );

    return {
      nativeGasCost: computeUnitsConsumed,
      tokenGasCost: gasPrice,
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
    deposit: Omit<Deposit, "messageHash">,
    _relayer = getDefaultSimulatedRelayerAddress(deposit.destinationChainId)
  ): Promise<BigNumber> {
    const fillRelayTx = await this.getFillRelayTx(deposit, _relayer);
    const computeUnitsConsumed = toBN(await this.computeUnitEstimator(fillRelayTx));
    return computeUnitsConsumed;
  }

  /**
   * @notice Return the fillRelay transaction for a given deposit
   * @param deposit
   * @param relayer SVM address of the relayer
   * @returns FillRelay transaction
   */
  async getFillRelayTx(
    deposit: Omit<Deposit, "messageHash">,
    _relayer = getDefaultSimulatedRelayerAddress(deposit.destinationChainId)
  ) {
    const relayer = _relayer ? toAddressType(_relayer).forceSvmAddress() : this.simulatedRelayerAddress;
    // If the user did not have a token account created on destination, then we need to include this as a gas cost.
    const mint = toAddressType(deposit.outputToken).forceSvmAddress();
    const owner = toAddressType(deposit.recipient).forceSvmAddress();
    const associatedToken = await getAssociatedTokenAddress(owner, mint);
    const simulatedSigner = SolanaVoidSigner(relayer.toBase58());

    // If the recipient has an associated token account on destination, then skip generating the instruction for creating a new token account.
    let recipientCreateTokenAccountInstructions: IInstruction[] | undefined = undefined;
    const [associatedTokenAccountExists, mintInfo] = await Promise.all([
      (await fetchEncodedAccount(this.provider, associatedToken)).exists,
      fetchMint(this.provider, mint.toV2Address()),
    ]);
    if (!associatedTokenAccountExists) {
      const createATAInstruction = await getCreateAssociatedTokenInstructionAsync({
        payer: simulatedSigner,
        ata: associatedToken,
        owner: owner.toV2Address(),
        mint: mint.toV2Address(),
      });
      recipientCreateTokenAccountInstructions = [createATAInstruction];
    }

    const [createTokenAccountsIx, approveIx, fillIx] = await Promise.all([
      createTokenAccountsInstruction(mint, simulatedSigner),
      createApproveInstruction(
        mint,
        deposit.outputAmount,
        this.simulatedRelayerAddress,
        this.spokePoolAddress,
        mintInfo.data.decimals
      ),
      fillRelayInstruction(this.spokePoolAddress, deposit, simulatedSigner, associatedToken),
    ]);

    // Get the most recent confirmed blockhash.
    const recentBlockhash = await this.provider.getLatestBlockhash().send();
    const fillRelayTx = pipe(
      createTransactionMessage({ version: 0 }),
      (tx) =>
        setTransactionMessageFeePayer(
          SvmAddress.from("86ZyCV5E9XRYucpvQX8jupXveGyDLpnbmi8v5ixpXCrT", "base58").toV2Address(),
          tx
        ),
      (tx) => setTransactionMessageLifetimeUsingBlockhash(recentBlockhash.value, tx),
      (tx) =>
        isDefined(recipientCreateTokenAccountInstructions)
          ? appendTransactionMessageInstructions(recipientCreateTokenAccountInstructions, tx)
          : tx,
      (tx) => appendTransactionMessageInstructions([createTokenAccountsIx, approveIx, fillIx], tx)
    );
    return fillRelayTx;
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
