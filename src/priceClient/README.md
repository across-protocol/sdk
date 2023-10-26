# Price Client
An interface for retrieving Ethereum ERC20 prices from various price feeds.

# Overview
The PriceClient aggregates user-defined preferential list of price feeds. This permits prices to be retrieved from a range of sources according to preference (i.e. failover to a lesser-preferred source in the event that a more-preferred source is unavailable).

## Features
 - Basic support for caching of prices.
 - Support for bundling token price requests.
 - Currently supported price feeds:
     - CoinGecko (Free & Pro)
     - Across API
 - Candidates for future addition:
     - DefiLlama
     - On-chain lookups (i.e. Uniswap)

This code can be independently used by bots, the frontend, and the backend Across API:
 - Bots can source their prices from the Across API, falling back to CoinGecko.
 - The frontend can use this for greater robustness, and to abstract away the source of its price feeds.
 - The API can add additional fallback price feeds to ensure that it is always able to resolve a price.

The interface exposed by this feature maps very closely to our existing Coingecko API.

### Preferential token price lookups
The PriceClient is initialised with an ordered list of Price Feeds. When performing price lookups, it will iterate through this list until it is able to successfully resolve a price for the requested tokens.

### Token price cache with configurable age
PriceClient.maxPriceAge controls the maximum age (in seconds) for cached prices. When a price is requested by a caller, the PriceClient will serve directly out of its internal cache if it holds a price that is younger than the maximum price age. This bypasses an external price lookup and may be used to mitigate rate-limiting. If no price is held, or if an expired price is held, then the PriceClient will perform the lookup against its ordered list of price feeds.

## Constraints
- There is no mapping of individual tokens to upstream PriceFeedAdapters.
  If some tokens are only available from specific sources, then a separate
  PriceClient instance may be used.

## Usage
Usage instructions will be added.
