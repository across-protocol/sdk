import { pipe } from "@solana/functional";
import { Coingecko } from "../../coingecko";
import { SymbolMappingType } from "./";
import { CHAIN_IDs, DEFAULT_SIMULATED_RELAYER_ADDRESS } from "../../constants";
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
import { Logger, QueryInterface } from "../relayFeeCalculator";
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
import { TOKEN_PROGRAM_ADDRESS, getMintSize, getInitializeMintInstruction, fetchMint } from "@solana-program/token";
import { getCreateAccountInstruction } from "@solana-program/system";

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
    options: Partial<{
      gasPrice: BigNumberish;
      gasUnits: BigNumberish;
      baseFeeMultiplier: BigNumber;
      priorityFeeMultiplier: BigNumber;
    }> = {}
  ): Promise<TransactionCostEstimate> {
    // If the user did not have a token account created on destination, then we need to include this as a gas cost.
    const mint = toAddressType(deposit.outputToken).forceSvmAddress();
    const owner = toAddressType(deposit.recipient).forceSvmAddress();
    const associatedToken = await getAssociatedTokenAddress(owner, mint);
    const simulatedSigner = SolanaVoidSigner(this.simulatedRelayerAddress.toBase58());

    // If the recipient has an associated token account on destination, then skip generating the instruction for creating a new token account.
    let recipientCreateTokenAccountInstructions: IInstruction[] | undefined = undefined;
    const [associatedTokenAccountExists, mintInfo] = await Promise.all([
      (await fetchEncodedAccount(this.provider, associatedToken)).exists,
      fetchMint(this.provider, mint.toV2Address()),
    ]);
    if (!associatedTokenAccountExists) {
      const space = BigInt(getMintSize());
      const rent = await this.provider.getMinimumBalanceForRentExemption(space).send();
      const createAccountIx = getCreateAccountInstruction({
        payer: simulatedSigner,
        newAccount: SolanaVoidSigner(mint.toBase58()),
        lamports: rent,
        space,
        programAddress: TOKEN_PROGRAM_ADDRESS,
      });

      const initializeMintIx = getInitializeMintInstruction({
        mint: mint.toV2Address(),
        decimals: mintInfo.data.decimals,
        mintAuthority: owner.toV2Address(),
      });
      recipientCreateTokenAccountInstructions = [createAccountIx, initializeMintIx];
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
      (tx) => setTransactionMessageFeePayer(this.simulatedRelayerAddress.toV2Address(), tx),
      (tx) => setTransactionMessageLifetimeUsingBlockhash(recentBlockhash.value, tx),
      (tx) =>
        isDefined(recipientCreateTokenAccountInstructions)
          ? appendTransactionMessageInstructions(recipientCreateTokenAccountInstructions, tx)
          : tx,
      (tx) => appendTransactionMessageInstructions([createTokenAccountsIx, approveIx, fillIx], tx)
    );

    const [computeUnitsConsumed, _gasPriceEstimate] = await Promise.all([
      toBN(await this.computeUnitEstimator(fillRelayTx)),
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
