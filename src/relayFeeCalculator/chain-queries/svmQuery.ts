import { pipe } from "@solana/functional";
import { Coingecko } from "../../coingecko";
import { SymbolMappingType } from "./";
import { CHAIN_IDs, DEFAULT_SIMULATED_RELAYER_ADDRESS } from "../../constants";
import { Deposit } from "../../interfaces";
import { BigNumberish, TransactionCostEstimate, BigNumber, SvmAddress, bnZero, toBN, isDefined } from "../../utils";
import { TransactionInstruction } from "@solana/web3.js";
import web3, {
  RpcTransport,
  createTransactionMessage,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  appendTransactionMessageInstructions,
  getComputeUnitEstimateForTransactionMessageFactory,
} from "@solana/kit";
import {
  createAssociatedTokenAccountInstruction,
  getAssociatedTokenAddressSync,
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAccount,
} from "@solana/spl-token";
import { fillRelayInstruction, createApproveInstruction, createTokenAccountsInstruction } from "../../arch/svm";
import { Logger, QueryInterface } from "../relayFeeCalculator";
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
    readonly provider: web3.Rpc<web3.SolanaRpcApiFromTransport<RpcTransport>>,
    readonly symbolMapping: SymbolMappingType,
    readonly spokePoolAddress: SvmAddress,
    readonly simulatedRelayerAddress: SvmAddress,
    readonly logger: Logger,
    readonly coingeckoProApiKey?: string,
    readonly fixedGasPrice?: BigNumberish,
    readonly coingeckoBaseCurrency: string = "eth"
  ) {
    this.computeUnitEstimator = getComputeUnitEstimateForTransactionMessageFactory({
      provider,
    });
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
    _relayer = DEFAULT_SIMULATED_RELAYER_ADDRESS,
    _options: Partial<{
      gasPrice: BigNumberish;
      gasUnits: BigNumberish;
      baseFeeMultiplier: BigNumber;
      priorityFeeMultiplier: BigNumber;
    }> = {}
  ): Promise<TransactionCostEstimate> {
    // If the user did not have a token account created on destination, then we need to include this as a "gascost.
    const mint = SvmAddress.from(deposit.outputToken);
    const owner = SvmAddress.from(deposit.recipient);
    const associatedToken = getAssociatedTokenAddressSync(
      mint.toPublicKey(),
      owner.toPublicKey(),
      true,
      TOKEN_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID
    );

    // If the recipient has an associated token account on destination, then skip generating the instruction for creating a new token account.
    let recipientCreateTokenAccountInstruction: TransactionInstruction | undefined = undefined;
    try {
      await getAccount(this.provider.connection, associatedToken, undefined, TOKEN_PROGRAM_ID);
    } catch {
      recipientCreateTokenAccountInstruction = createAssociatedTokenAccountInstruction(
        this.simulatedRelayerAddress.toPublicKey(),
        associatedToken,
        owner.toPublicKey(),
        mint.toPublicKey(),
        TOKEN_PROGRAM_ID,
        ASSOCIATED_TOKEN_PROGRAM_ID
      );
    }

    const [createTokenAccountsIx, approveIx, fillIx] = await Promise.all([
      createTokenAccountsInstruction(mint, this.simulatedRelayerAddress),
      createApproveInstruction(mint, deposit.outputAmount, this.simulatedRelayerAddress, this.spokePoolAddress),
      fillRelayInstruction(
        this.spokePoolAddress,
        deposit,
        this.simulatedRelayerAddress,
        SvmAddress.from(associatedToken.toString())
      ),
    ]);

    // Get the most recent confirmed blockhash.
    const recentBlockhash = await this.provider.getLatestBlockhash().send();
    const fillRelayMessage = pipe(
      createTransactionMessage({ version: 0 }),
      (tx) => setTransactionMessageFeePayer(this.simulatedRelayerAddress.toV2Address(), tx),
      (tx) => setTransactionMessageLifetimeUsingBlockhash(recentBlockhash, tx),
      (tx) =>
        isDefined(recipientCreateTokenAccountInstruction)
          ? appendTransactionMessageInstructions([recipientCreateTokenAccountInstruction], tx)
          : tx,
      (tx) => appendTransactionMessageInstructions([createTokenAccountsIx, approveIx, fillIx], tx)
    );

    const computeUnitsConsumed = toBN(await this.computeUnitEstimator(fillRelayMessage));

    const tokenGasCost = bnZero; // TODO;

    return {
      nativeGasCost: computeUnitsConsumed,
      tokenGasCost,
      gasPrice: computeUnitsConsumed.mul(tokenGasCost),
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
