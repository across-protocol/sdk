import sinon from "sinon";
import { BundleDataClient } from "../src/clients/BundleDataClient";
import { expect, createSpyLogger } from "./utils";

describe("BundleDataClient Arweave fallback behavior", () => {
  afterEach(() => {
    sinon.restore();
  });

  it("should fall back to on-chain reconstruction when the Arweave load throws", async () => {
    const { spyLogger } = createSpyLogger();
    const bundleDataClient = new BundleDataClient(spyLogger, {} as any, {}, [], {});
    const blockRanges = [[100, 123]];
    const expected = {
      bundleDepositsV3: { 1: {} },
      expiredDepositsToRefundV3: {},
      bundleFillsV3: {},
      unexecutableSlowFills: {},
      bundleSlowFillsV3: {},
    };

    sinon.stub(bundleDataClient as any, "loadArweaveData").rejects(new Error("gateway timeout"));
    sinon.stub(bundleDataClient as any, "loadDataFromScratch").resolves(expected);

    const result = await bundleDataClient.loadData(blockRanges, {} as any, true);

    expect(result).to.deep.equal(expected);
  });
});
