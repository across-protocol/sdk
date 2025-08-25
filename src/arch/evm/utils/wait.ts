import assert from "assert";
import { createPublicClient, http, isAddress, Log } from "viem";
import { isDefined } from "../../../utils";

export enum WAITFOR_FAIL {
  TIMEOUT,
}

export type WaitForResponse = { error: false; txnRef: string } | { error: true; reason: WAITFOR_FAIL.TIMEOUT };

type EventFilter = {
  address: string;
  event: string; // RootBundleExecuted(...)
  timeout: number; // seconds
};

export function waitFor(providerUrl: string, eventFilter: EventFilter): Promise<WaitForResponse> {
  const provider = createPublicClient({
    transport: http(providerUrl),
  });

  const { address } = eventFilter;
  const timeout = eventFilter.timeout * 1000;
  assert(!isDefined(address) || isAddress(address));

  return new Promise((resolve) => {
    const abortController = new AbortController();

    const onLogs = (logs: Log[]) => {
      const txnRef = logs[0].transactionHash as string;
      abortController.abort();
      resolve({ error: false, txnRef });
    };

    const timeoutId = setTimeout(() => {
      abortController.abort();
      resolve({ error: true, reason: WAITFOR_FAIL.TIMEOUT });
    }, timeout);

    const unsub = provider.watchEvent({ address, onLogs });

    abortController.signal.addEventListener("abort", () => {
      clearTimeout(timeoutId);
      unsub();
    });
  });
}

async function run() {
  const { RPC_PROVIDER: url } = process.env;
  assert(isDefined(url), "No mainnet RPC_PROVIDER defined");

  const event = "RootBundleExecuted(uint256,uint256,uint256,address[],uint256[],int256[],int256[],address)";
  const filter = {
    address: "0xc186fA914353c44b2E33eBE05f21846F1048bEda",
    event,
    timeout: 5400,
  };

  const result = await waitFor(url, filter);
  if (result.error) {
    switch (result.reason) {
      case WAITFOR_FAIL.TIMEOUT:
        console.log("Error: timed out waiting for event");
        break;
      default:
        console.log(`Unknown error (${result.reason})`);
    }
    throw Error;
  }

  console.log(`Event transaction hash: ${result.txnRef}`);
}

if (require.main === module) {
  run()
    .then(() => {
      process.exitCode = 0;
    })
    .catch(() => {
      console.error("Process errored");
      process.exitCode = 9;
    });
}
