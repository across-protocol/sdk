import assert from "assert";
import { SvmSpokeClient } from "@across-protocol/contracts";
import { intToU8Array32 } from "@across-protocol/contracts/dist/src/svm/web3-v1/conversionUtils";
import { SYSTEM_PROGRAM_ADDRESS } from "@solana-program/system";
import { ASSOCIATED_TOKEN_PROGRAM_ADDRESS, fetchMint } from "@solana-program/token";
import { getComputeUnitEstimateForTransactionMessageFactory } from "@solana/kit";
import {
  SVMProvider,
  SolanaVoidSigner,
  createFillInstruction,
  getAssociatedTokenAddress,
  getEventAuthority,
  getFillRelayDelegatePda,
  getFillStatusPda,
  getStatePda,
  toAddress,
} from "../../arch/svm";
import { Coingecko } from "../../coingecko";
import { CHAIN_IDs } from "../../constants";
import { getGasPriceEstimate } from "../../gasPriceOracle";
import { RelayData } from "../../interfaces";
import {
  BigNumber,
  BigNumberish,
  SvmAddress,
  TransactionCostEstimate,
  getRelayDataHash,
  toAddressType,
  toBN,
} from "../../utils";
import { Logger, QueryInterface, getDefaultSimulatedRelayerAddress } from "../relayFeeCalculator";
import { SymbolMappingType } from "./";

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
    relayer = toAddressType(getDefaultSimulatedRelayerAddress(relayData.destinationChainId), relayData.destinationChainId),
    options: Partial<{
      gasPrice: BigNumberish;
      gasUnits: BigNumberish;
      baseFeeMultiplier: BigNumber;
      priorityFeeMultiplier: BigNumber;
    }> = {}
  ): Promise<TransactionCostEstimate> {
    const { recipient, outputToken, exclusiveRelayer } = relayData;
    assert(recipient.isSVM(), `getGasCosts: recipient not an SVM address (${recipient})`);
    assert(outputToken.isSVM(), `getGasCosts: outputToken not an SVM address (${outputToken})`);
    assert(exclusiveRelayer.isSVM(), `getGasCosts: exclusiveRelayer not an SVM address (${exclusiveRelayer})`);

    const fillRelayTx = await this.getFillRelayTx({ ...relayData, recipient, outputToken, exclusiveRelayer }, relayer);

    const [computeUnitsConsumed, gasPriceEstimate] = await Promise.all([
      toBN(await this.computeUnitEstimator(fillRelayTx)),
      getGasPriceEstimate(this.provider, {
        unsignedTx: fillRelayTx,
        baseFeeMultiplier: options.baseFeeMultiplier,
        priorityFeeMultiplier: options.priorityFeeMultiplier,
      }),
    ]);

    // We can cast the gas price estimate to an SvmGasPriceEstimate here since the oracle should always
    // query the Solana adapter.
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
    deposit: RelayData & { destinationChainId: number },
    _relayer = toAddressType(getDefaultSimulatedRelayerAddress(deposit.destinationChainId), deposit.destinationChainId)
  ): Promise<BigNumber> {
    const { recipient, outputToken, exclusiveRelayer } = deposit;
    assert(recipient.isSVM(), `getNativeGasCost: recipient not an SVM address (${recipient})`);
    assert(outputToken.isSVM(), `getNativeGasCost: outputToken not an SVM address (${outputToken})`);
    assert(exclusiveRelayer.isSVM(), `getNativeGasCost: exclusiveRelayer not an SVM address (${exclusiveRelayer})`);

    const fillRelayTx = await this.getFillRelayTx({ ...deposit, recipient, outputToken, exclusiveRelayer }, _relayer);
    return toBN(await this.computeUnitEstimator(fillRelayTx));
  }

  /**
   * @notice Return the fillRelay transaction for a given deposit
   * @param relayData RelayData instance, supplemented with destinationChainId
   * @param relayer SVM address of the relayer
   * @returns FillRelay transaction
   */
  async getFillRelayTx(
    relayData: Omit<RelayData, "recipent" | "outputToken"> & {
      destinationChainId: number;
      recipient: SvmAddress;
      outputToken: SvmAddress;
    },
    relayer = toAddressType(getDefaultSimulatedRelayerAddress(relayData.destinationChainId), relayData.destinationChainId),
    repaymentChainId = relayData.destinationChainId,
    repaymentAddress = toAddressType(
      getDefaultSimulatedRelayerAddress(relayData.destinationChainId),
      relayData.destinationChainId
    )
  ) {
    const { depositor, recipient, inputToken, outputToken, exclusiveRelayer, destinationChainId } = relayData;

    // tsc appeasement...should be unnecessary, but isn't. @todo Identify why.
    assert(recipient.isSVM(), `getFillRelayTx: recipient not an SVM address (${recipient})`);
    assert(
      repaymentAddress.isValidOn(repaymentChainId),
      `getFillRelayTx: repayment address ${repaymentAddress} not valid on chain ${repaymentChainId})`
    );

    const program = toAddress(this.spokePool);
    const _relayDataHash = getRelayDataHash(relayData, destinationChainId);
    const relayDataHash = new Uint8Array(Buffer.from(_relayDataHash.slice(2), "hex"));

    const [state, delegate] = await Promise.all([
      getStatePda(program),
      getFillRelayDelegatePda(relayDataHash, BigInt(repaymentChainId), toAddress(repaymentAddress), program),
    ]);

    const mint = toAddress(outputToken);
    const mintInfo = await fetchMint(this.provider, mint);

    const [recipientAta, relayerAta, fillStatus, eventAuthority] = await Promise.all([
      getAssociatedTokenAddress(recipient, outputToken, mintInfo.programAddress),
      getAssociatedTokenAddress(SvmAddress.from(relayer.toBase58()), outputToken, mintInfo.programAddress),
      getFillStatusPda(program, relayData, destinationChainId),
      getEventAuthority(program),
    ]);

    const svmRelayData: SvmSpokeClient.FillRelayInput["relayData"] = {
      depositor: toAddress(depositor),
      recipient: toAddress(recipient),
      exclusiveRelayer: toAddress(exclusiveRelayer),
      inputToken: toAddress(inputToken),
      outputToken: mint,
      inputAmount: relayData.inputAmount.toBigInt(),
      outputAmount: relayData.outputAmount.toBigInt(),
      originChainId: relayData.originChainId,
      depositId: new Uint8Array(intToU8Array32(relayData.depositId.toNumber())),
      fillDeadline: relayData.fillDeadline,
      exclusivityDeadline: relayData.exclusivityDeadline,
      message: new Uint8Array(Buffer.from(relayData.message, "hex")),
    };

    const simulatedSigner = SolanaVoidSigner(relayer.toBase58());
    const fillInput: SvmSpokeClient.FillRelayInput = {
      signer: simulatedSigner,
      state,
      delegate,
      mint,
      relayerTokenAccount: relayerAta,
      recipientTokenAccount: recipientAta,
      fillStatus,
      tokenProgram: mintInfo.programAddress,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ADDRESS,
      systemProgram: SYSTEM_PROGRAM_ADDRESS,
      eventAuthority,
      program,
      relayHash: relayDataHash,
      relayData: svmRelayData,
      repaymentChainId: BigInt(repaymentChainId),
      repaymentAddress: toAddress(repaymentAddress),
    };
    // Pass createRecipientAtaIfNeeded =true to the createFillInstruction function to create the recipient token account
    // if it doesn't exist.
    return createFillInstruction(simulatedSigner, this.provider, fillInput, mintInfo.data.decimals, true);
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
