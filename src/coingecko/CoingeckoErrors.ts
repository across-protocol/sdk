/**
 * Thrown when a price lookup against the Coingecko API does not return a
 * usable price for the requested identifier. Callers can use `instanceof` to
 * map this to a 404 / not-found response without needing to string-match
 * the underlying message.
 */
export type CoingeckoLookupType = "symbol" | "address" | "id";

export class CoingeckoPriceNotFoundError extends Error {
  readonly identifier: string;
  readonly currency: string;
  readonly lookupType: CoingeckoLookupType;

  constructor(args: { identifier: string; currency: string; lookupType: CoingeckoLookupType; cause?: unknown }) {
    super(
      `No Coingecko price found for ${args.lookupType} '${args.identifier}' in ${args.currency}`,
      args.cause !== undefined ? { cause: args.cause } : undefined
    );
    this.name = "CoingeckoPriceNotFoundError";
    this.identifier = args.identifier;
    this.currency = args.currency;
    this.lookupType = args.lookupType;
  }
}
