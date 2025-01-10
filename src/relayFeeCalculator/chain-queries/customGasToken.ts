import { CHAIN_IDs } from "../../constants";
import { Coingecko } from "../../coingecko/Coingecko";
import { QueryBase } from "./baseQuery";

type QueryBaseArgs = ConstructorParameters<typeof QueryBase>;

export class CustomGasTokenQueries extends QueryBase {
  readonly customGasTokenSymbol: string;

  constructor(args: { queryBaseArgs: QueryBaseArgs; customGasTokenSymbol: string }) {
    super(...args.queryBaseArgs);
    this.customGasTokenSymbol = args.customGasTokenSymbol;
  }

  override async getTokenPrice(tokenSymbol: string): Promise<number> {
    if (!this.symbolMapping[tokenSymbol]) throw new Error(`${tokenSymbol} does not exist in mapping`);
    const coingeckoInstance = Coingecko.get(this.logger, this.coingeckoProApiKey);
    const [, tokenPrice] = await coingeckoInstance.getCurrentPriceByContract(
      this.symbolMapping[tokenSymbol].addresses[CHAIN_IDs.MAINNET],
      "usd"
    );

    const [, customGasTokenPrice] = await coingeckoInstance.getCurrentPriceByContract(
      this.symbolMapping[this.customGasTokenSymbol].addresses[CHAIN_IDs.MAINNET],
      "usd"
    );
    return Number((tokenPrice / customGasTokenPrice).toFixed(this.symbolMapping[this.customGasTokenSymbol].decimals));
  }
}
