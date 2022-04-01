# Transfers history client

This client is used for fetching the history of the assets tranfered between chains using Across V2 contracts.

## Usage
```ts
import { transfersHistory } from "@across/sdk-v2"

const { TransfersHistoryClient } = transfersHistory;

const client = new TransfersHistoryClient({
  chains: [
    { chainId: <chain_id>, providerUrl: <provider_url>, spokePoolContractAddr: <spoke_pool_address> }
  ],
  // optional 
  pollingIntervalSeconds: <polling_interval_in_seconds>
});
// optional
client.setLogLevel("debug");
await client.startFetchingTransfers(<depositor_addr>);
client.on(TransfersHistoryEvent.TransfersUpdated, data => {
  const { depositorAddr, filledTransfersCount, pendingTransfersCount } = data;
  // do whatever you need with the data
});

const pendingTransfers = client.getPendingTransfers(<depositor_addr>, <limit>, <offset>);
/**
 * 
 * Transfers type:
 * {
 *   depositId: number;
 *   depositTime: number;
 *   status: TransferStatus;
 *   filled: BigNumber;
 *   sourceChainId: ChainId;
 *   destinationChainId: number;
 *   assetAddr: string;
 *   amount: BigNumber;
 *   depositTxHash: string;
 * }[]
 */
const filledTransfers = client.getFilledTransfers(<depositor_addr>, <limit>, <offset>);
client.stopFetchingTransfers(<depositor_addr>);
```
