import { QueryBase } from "./baseQuery";

type QueryBaseArgs = ConstructorParameters<typeof QueryBase>;

export class CustomGasTokenQueries extends QueryBase {
  readonly customGasTokenSymbol: string;

  constructor(args: { queryBaseArgs: QueryBaseArgs; customGasTokenSymbol: string }) {
    super(...args.queryBaseArgs);
    this.customGasTokenSymbol = args.customGasTokenSymbol;
  }

  override async getTokenPrice(tokenSymbol: string): Promise<number> {
    const [customGasTokenPrice, tokenPrice] = await Promise.all([
      super.getTokenPrice(this.customGasTokenSymbol),
      super.getTokenPrice(tokenSymbol),
    ]);

    return Number((tokenPrice / customGasTokenPrice).toFixed(this.symbolMapping[this.customGasTokenSymbol].decimals));
  }
}
