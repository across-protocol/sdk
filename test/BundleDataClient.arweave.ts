import sinon from "sinon";
import { BundleDataClient } from "../src/clients/BundleDataClient";
import { AcrossConfigStoreClient, HubPoolClient } from "../src/clients";
import { ArweaveClient } from "../src/caching";
import { Clients, LoadDataReturnValue, SpokePoolClientsByChain } from "../src/interfaces";
import { expect, createSpyLogger } from "./utils";

function makeStubClients(): Clients {
  return {
    arweaveClient: Object.create(ArweaveClient.prototype) as ArweaveClient,
    hubPoolClient: Object.create(HubPoolClient.prototype) as HubPoolClient,
    configStoreClient: Object.create(AcrossConfigStoreClient.prototype) as AcrossConfigStoreClient,
  };
}

function setHiddenMethod(target: object, key: string, value: unknown): void {
  Object.defineProperty(target, key, {
    configurable: true,
    value,
  });
}

describe("BundleDataClient Arweave fallback behavior", () => {
  afterEach(() => {
    sinon.restore();
  });

  it("should fall back to on-chain reconstruction when the Arweave load throws", async () => {
    const { spyLogger } = createSpyLogger();
    const bundleDataClient = new BundleDataClient(spyLogger, makeStubClients(), {}, [], {});
    const blockRanges = [[100, 123]];
    const spokePoolClients: SpokePoolClientsByChain = {};
    const expected: LoadDataReturnValue = {
      bundleDepositsV3: { 1: {} },
      expiredDepositsToRefundV3: {},
      bundleFillsV3: {},
      unexecutableSlowFills: {},
      bundleSlowFillsV3: {},
    };

    setHiddenMethod(bundleDataClient, "loadArweaveData", sinon.stub().rejects(new Error("gateway timeout")));
    setHiddenMethod(bundleDataClient, "loadDataFromScratch", sinon.stub().resolves(expected));

    const result = await bundleDataClient.loadData(blockRanges, spokePoolClients, true);

    expect(result).to.deep.equal(expected);
  });
});
