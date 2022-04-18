import assert from "assert";
import * as uma from "@uma/sdk";
import { Provider } from "@ethersproject/providers";
import { BigNumber } from "ethers";
import { BigNumberish, toBNWei, nativeToToken, gasCost } from "../utils";
const Coingecko = uma.Coingecko;
const { percent, fixedPointAdjustment } = uma.across.utils;
const { connect: erc20Connect } = uma.clients.erc20;

export interface QueryInterface {
  getGasCosts: (tokenAddress?: string) => Promise<BigNumberish>;
  getTokenPrice: (tokenAddress: string) => Promise<number | string>;
  getTokenDecimals: (tokenAddress: string) => Promise<number>;
}

// Override this to add different behaviors for different chains.
export class DefaultQueries implements QueryInterface {
  private coingecko: uma.Coingecko;
  /**
   * constructor.
   *
   * @param {Provider} provider - For the default query class, the provider is for the destination chain.
   * @param {string} priceSymbol - The symbol of the native gas token on the destination chain.
   * @param {} defaultGas - hardcoded gas required to submit a relay on the destination chain.
   */
  constructor(private provider: Provider, private priceSymbol: string = "eth", private defaultGas = "305572") {
    this.coingecko = new Coingecko();
  }
  /**
   * getGasCosts. This should calculate how much of the native gas token is used for a relay on the destination chain.
   *
   * @returns {Promise<BigNumberish>}
   */
  async getGasCosts(): Promise<BigNumberish> {
    const { gasPrice, maxFeePerGas } = await this.provider.getFeeData();
    const price = maxFeePerGas || gasPrice;
    assert(price, "Unable to get gas price");
    return gasCost(this.defaultGas, price);
  }
  /**
   * getTokenPrice. This should return the price of a token relative to the native gas token on the
   * destination chain. This is tricky because the token address provided should be the token address
   * on the destination chain, which may not be easily accessible when sending relay.
   *
   * @param {string} tokenAddress
   * @returns {Promise<number | string>}
   */
  async getTokenPrice(tokenAddress: string): Promise<number | string> {
    const [, tokenPrice] = await this.coingecko.getCurrentPriceByContract(tokenAddress, this.priceSymbol.toLowerCase());
    return tokenPrice;
  }
  /**
   * getTokenDecimals. Gets token decimals, its assumed decimals are the same on both chains.
   *
   * @param {string} tokenAddress
   * @returns {Promise<number>}
   */
  async getTokenDecimals(tokenAddress: string): Promise<number> {
    const erc20Client = erc20Connect(tokenAddress, this.provider);
    return erc20Client.decimals();
  }
}

interface RelayFeeCalculatorConfig {
  nativeTokenDecimals?: number;
  discountPercent?: number;
  feeLimitPercent?: number;
  queries: QueryInterface;
}

export class RelayFeeCalculator {
  private queries: Required<RelayFeeCalculatorConfig>["queries"];
  private discountPercent: Required<RelayFeeCalculatorConfig>["discountPercent"];
  private feeLimitPercent: Required<RelayFeeCalculatorConfig>["feeLimitPercent"];
  private nativeTokenDecimals: Required<RelayFeeCalculatorConfig>["nativeTokenDecimals"];
  constructor(config: RelayFeeCalculatorConfig) {
    this.queries = config.queries;
    this.discountPercent = config.discountPercent || 0;
    this.feeLimitPercent = config.feeLimitPercent || 0;
    this.nativeTokenDecimals = config.nativeTokenDecimals || 18;
    assert(
      this.discountPercent >= 0 && this.discountPercent <= 100,
      "discountPercent must be between 0 and 100 percent"
    );
    assert(
      this.feeLimitPercent >= 0 && this.feeLimitPercent <= 100,
      "feeLimitPercent must be between 0 and 100 percent"
    );
  }
  async relayerFeePercent(amountToRelay: BigNumberish, tokenAddress?: string): Promise<BigNumberish> {
    const gasCosts = await this.queries.getGasCosts(tokenAddress);
    // if not provided, its assumed the token is the same denomination as the destination gas token
    if (!tokenAddress) {
      return percent(gasCosts, amountToRelay).toString();
    }
    const tokenPrice = await this.queries.getTokenPrice(tokenAddress);
    const decimals = await this.queries.getTokenDecimals(tokenAddress);
    const gasFeesInToken = nativeToToken(gasCosts, tokenPrice, decimals, this.nativeTokenDecimals);
    return percent(gasFeesInToken, amountToRelay).toString();
  }
  async relayerFeeDetails(amountToRelay: BigNumberish, tokenAddress?: string) {
    let isAmountTooLow = false;
    const relayFeePercent = await this.relayerFeePercent(amountToRelay, tokenAddress);
    const relayFeeTotal = BigNumber.from(relayFeePercent)
      .mul(amountToRelay)
      .div(fixedPointAdjustment)
      .toString();
    if (this.feeLimitPercent) {
      isAmountTooLow = BigNumber.from(relayFeePercent).gt(toBNWei(this.feeLimitPercent / 100));
    }
    return {
      amountToRelay: amountToRelay.toString(),
      relayFeePercent,
      relayFeeTotal,
      discountPercent: this.discountPercent,
      feeLimitPercent: this.feeLimitPercent,
      tokenAddress,
      isAmountTooLow,
    };
  }
}
