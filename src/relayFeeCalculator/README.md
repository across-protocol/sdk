# Relay Fee Calculator

Calculates relay fee percentages for a relay deposit.

## Usage

See tests for more documentation: [Relay Fee Calculator Test]("./relayFeeDetails.test.ts")

```ts
import * as across from "@across/sdk-v2"
import {ethers} from 'ethers'

const {RelayFeeCalculator, DefaultQueries} = across.relayFeeCalculator

const mainnetUsdcAddress = ethers.utils.getAddress("0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48")

// Relay fee calculator requires different queries depending on the chain, the default works with mainnet.
const provider = ethers.getDefaultProvider(process.env.CUSTOM_NODE_URL);
const queries = new DefaultQueries(provider)
const client = new RelayFeeCalculator({queries})
const result = await client.relayerFeeDetails(100000000,mainnetUsdcAddress)
// result =
// {
//   amountToRelay: '100000000',
//   relayFeePercent: '878173320000000000',
//   relayFeeTotal: '87817332',
//   discountPercent: 0,
//   feeLimitPercent: 0,
//   tokenAddress: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
//   isAmountTooLow: false
// }

```

