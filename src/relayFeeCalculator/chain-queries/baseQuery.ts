import { SpokePool, SpokePool__factory } from "../../typechain";
import { L2Provider } from "@eth-optimism/sdk/dist/interfaces/l2-provider";
import { providers } from "ethers";
import { Coingecko } from "../../coingecko";
import { CHAIN_IDs, DEFAULT_SIMULATED_RELAYER_ADDRESS } from "../../constants";
import {
  BigNumberish,
  createUnsignedFillRelayTransactionFromDeposit,
  estimateTotalGasRequiredByUnsignedTransaction,
  isV2Deposit,
  populateV3Relay,
  toBN,
  TransactionCostEstimate,
} from "../../utils";
import { Logger, QueryInterface } from "../relayFeeCalculator";
import { Deposit, V2Deposit, V3Deposit } from "../../interfaces";

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
export default abstract class QueryBase implements QueryInterface {
  readonly spokePool: SpokePool;
  /**
   * Instantiates a QueryBase instance
   * @param provider A valid Ethers.js provider
   * @param symbolMapping A mapping to valid ERC20 tokens and their respective characteristics
   * @param spokePoolAddress The valid address of the Spoke Pool deployment
   * @param usdcAddress The valid token address of the USDC ERC-20 token
   * @param simulatedRelayerAddress The address that these queries will reference as the sender. Note: This address must be approved for USDC
   * @param gasMarkup A multiplier that is applied to the total gas estimate
   * @param logger A logging utility to report logs
   * @param coingeckoProApiKey An optional CoinGecko API key that links to a PRO account
   * @param fixedGasPrice Overrides the gas price with a fixed value. Note: primarily used for the Boba blockchain
   * @param coingeckoBaseCurrency The basis currency that CoinGecko will use to resolve pricing
   */
  protected constructor(
    readonly provider: Provider | OptimismProvider,
    readonly symbolMapping: SymbolMappingType,
    readonly spokePoolAddress: string,
    readonly simulatedRelayerAddress: string,
    readonly gasMarkup: number,
    readonly logger: Logger,
    readonly coingeckoProApiKey?: string,
    readonly fixedGasPrice?: BigNumberish,
    readonly coingeckoBaseCurrency: string = "eth"
  ) {
    this.spokePool = SpokePool__factory.connect(spokePoolAddress, provider);
  }

  /**
   * Retrieves the current gas costs of performing a fillRelay contract at the referenced SpokePool.
   * @param deposit Deposit instance (v2 or v3).
   * @param amountToRelay Amount of the deposit to fill.
   * @param relayerAddress Relayer address to simulate with.
   * @returns The gas estimate for this function call (multplied with the optional buffer).
   */
  getGasCosts(
    deposit: Deposit,
    fillAmount: BigNumberish,
    relayer = DEFAULT_SIMULATED_RELAYER_ADDRESS
  ): Promise<TransactionCostEstimate> {
    relayer ??= this.simulatedRelayerAddress;
    return isV2Deposit(deposit)
      ? this.getV2GasCosts(deposit, fillAmount, relayer)
      : this.getV3GasCosts(deposit, relayer);
  }

  /**
   * Retrieves the current gas costs of performing a fillRelay contract at the referenced SpokePool
   * @param deposit V2Deposit instance.
   * @param amountToRelay Amount of the deposit to fill.
   * @param relayer Relayer address to simulate with.
   * @returns The gas estimate for this function call (multplied with the optional buffer).
   */
  async getV2GasCosts(
    deposit: V2Deposit,
    amountToRelay: BigNumberish,
    relayer: string
  ): Promise<TransactionCostEstimate> {
    const tx = await createUnsignedFillRelayTransactionFromDeposit(
      this.spokePool,
      deposit,
      toBN(amountToRelay),
      relayer
    );
    return estimateTotalGasRequiredByUnsignedTransaction(
      tx,
      relayer,
      this.provider,
      this.gasMarkup,
      this.fixedGasPrice
    );
  }

  /**
   * Retrieves the current gas costs of performing a fillV3Relay contract at the referenced SpokePool.
   * @param deposit V3Deposit instance.
   * @param relayer Relayer address to simulate with.
   * @returns The gas estimate for this function call (multplied with the optional buffer).
   */
  async getV3GasCosts(deposit: V3Deposit, relayer: string): Promise<TransactionCostEstimate> {
    const tx = await populateV3Relay(this.spokePool, deposit, relayer);
    return estimateTotalGasRequiredByUnsignedTransaction(
      tx,
      relayer,
      this.provider,
      this.gasMarkup,
      this.fixedGasPrice
    );
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
