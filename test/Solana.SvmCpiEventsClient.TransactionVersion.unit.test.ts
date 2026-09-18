import { SvmSpokeIdl } from "@across-protocol/contracts";
import { expect } from "chai";
import { SvmCpiEventsClient } from "../src/arch/svm";

/**
 * Regression test for the transaction version ceiling sent to `getTransaction`.
 *
 * Solana activated the v1 transaction format on mainnet at epoch 1035. `getTransaction` rejects the
 * *entire request* with JSON-RPC error -32015 when the transaction it would return is newer than the
 * caller's `maxSupportedTransactionVersion`, so a hardcoded `0` here stalled the SVM CCTP indexer
 * outright: it reads Circle's shared TokenMessengerMinter and MessageTransmitter programs, whose
 * signature history contains every CCTP user's transactions, and the indexer retries a failed block
 * range forever without saving progress. A third party sending a v1 transaction is therefore enough
 * to wedge it — the ceiling is a property of what we can read, not of the version we send.
 */
describe("SvmCpiEventsClient (transaction version ceiling)", () => {
  // Mainnet SvmSpoke program.
  const PROGRAM = "DLv3NggMiSaef97YCkew5xKUHDh13tVGZ7tydt3ZeAru";
  const SIGNATURE = "3rLkGVvyYL2LTuDzbo8MBYNwjhYaKo1pEoqd24HCPQJEhNgyVnKZeNFsFrStKYY6cVizBfLpa2RMiB8dxHPzGHMV";

  it("asks the RPC to deserialize v1 transactions", async () => {
    const configs: Record<string, unknown>[] = [];

    // Minimal rpc stub: record the config each getTransaction call is made with. An empty tx body is
    // enough — this asserts the request we send, not what we decode from the response.
    const rpc = {
      getTransaction: (_signature: string, config: Record<string, unknown>) => {
        configs.push(config);
        return { send: () => Promise.resolve(undefined) };
      },
    } as unknown as Parameters<typeof SvmCpiEventsClient.createFor>[0];

    const client = await SvmCpiEventsClient.createFor(rpc, PROGRAM, SvmSpokeIdl);
    await client.readEventsFromSignature(SIGNATURE as Parameters<typeof client.readEventsFromSignature>[0]);

    expect(configs).to.have.lengthOf(1);
    expect(configs[0].maxSupportedTransactionVersion).to.equal(1);
    expect(configs[0].encoding).to.equal("json");
  });
});
