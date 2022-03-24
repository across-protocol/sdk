# Transfers history client

This client is used for fetching the history of the assets tranfered between chains using Across V2 contracts.

## Usage
```ts
import { transfersHistory } from "@across/sdk-v2"

const { TransfersHistoryClient } = transfersHistory;

const client = new TransfersHistoryClient({
  chains: [
    {
      chainId: ChainId.ARBITRUM_RINKEBY,
      providerUrl: process.env[`WEB3_NODE_URL_${ChainId.ARBITRUM_RINKEBY}`] || "",
    },
  ],
  refChainId: ChainId.ARBITRUM_RINKEBY,
});
const transfers = await client.getTransfers({ status: "pending" }, 2, 0);
```
