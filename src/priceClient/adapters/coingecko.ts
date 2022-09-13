import { Logger, PriceFeedAdapter, TokenPrice } from "../priceClient";
import { Coingecko as _Coingecko } from "../../coingecko"; // XXX temporary shim

/**
 * Note: This class is currently a thin shim to permit reuse of the existing Coingecko implementation.
 * The intention is to deprecate the existing version and migrate its functionality in here.
 */
export class PriceFeed implements PriceFeedAdapter {
  public readonly host: string;
  private cg: _Coingecko;

  constructor(
    public readonly name: string,
    readonly logger: Logger, // @todo: Remove logger (pending merge w/ Coingecko class).
    private readonly apiKey?: string
  ) {
    // @todo: Currently not used, but will be once after dedup of _Coingecko.
    this.host =
      typeof this.apiKey === "string" && this.apiKey.length > 0 ? "api.coingecko.com" : "pro-api.coingecko.com";

    this.cg = _Coingecko.get(logger, apiKey);
    this.cg.maxPriceAge = 0; // Caching is handled in the PriceClient, so disable it here.
  }

  async getPriceByAddress(address: string, currency: string, platform: string): Promise<TokenPrice> {
    const price: TokenPrice[] = await this.getPricesByAddress([address], platform, currency);
    return price[0];
  }

  async getPricesByAddress(addresses: string[], currency: string, platform: string): Promise<TokenPrice[]> {
    return await this.cg.getContractPrices(addresses, currency, platform);
  }
}
