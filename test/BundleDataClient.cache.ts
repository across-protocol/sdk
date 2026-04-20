import sinon from "sinon";
import { expect, createSpyLogger } from "./utils";
import { BundleDataClient } from "../src/clients/BundleDataClient";
import { MemoryCacheClient } from "../src/caching";
import { getArweaveTopicCacheKey } from "../src/utils";

describe("BundleDataClient Arweave cache behavior", () => {
  const blockRanges = [[100, 123]];
  const tag = `bundles-${BundleDataClient.getArweaveClientKey(blockRanges)}`;
  const emptyPersistedBundle = {
    bundleDepositsV3: {},
    expiredDepositsToRefundV3: {},
    bundleFillsV3: {},
    unexecutableSlowFills: {},
    bundleSlowFillsV3: {},
  };
  const emptyLoadDataResult = {
    bundleDepositsV3: {},
    expiredDepositsToRefundV3: {},
    bundleFillsV3: {},
    unexecutableSlowFills: {},
    bundleSlowFillsV3: {},
  };

  afterEach(() => {
    sinon.restore();
  });

  it("should load persisted bundle data from the topic cache before querying Arweave", async () => {
    const { spyLogger } = createSpyLogger();
    const cache = new MemoryCacheClient();
    const arweaveClient = { getByTopic: sinon.stub().rejects(new Error("should not query Arweave")) };
    const bundleDataClient = new BundleDataClient(spyLogger, { arweaveClient } as any, {}, [], {}, cache);

    await cache.set(getArweaveTopicCacheKey(tag), JSON.stringify(emptyPersistedBundle));

    const result = await (bundleDataClient as any).loadPersistedDataFromArweave(blockRanges);

    expect(result).to.deep.equal(emptyLoadDataResult);
    expect(arweaveClient.getByTopic.called).to.be.false;
  });

  it("should backfill the topic cache after a successful Arweave read", async () => {
    const { spyLogger } = createSpyLogger();
    const cache = new MemoryCacheClient();
    const arweaveClient = {
      getByTopic: sinon.stub().resolves([{ data: emptyPersistedBundle, hash: "tx-1" }]),
    };
    const bundleDataClient = new BundleDataClient(spyLogger, { arweaveClient } as any, {}, [], {}, cache);

    const result = await (bundleDataClient as any).loadPersistedDataFromArweave(blockRanges);
    const cachedPayload = await cache.get<string>(getArweaveTopicCacheKey(tag));

    expect(result).to.deep.equal(emptyLoadDataResult);
    expect(JSON.parse(cachedPayload!)).to.deep.equal(emptyPersistedBundle);
  });

  it("should ignore malformed cached payloads and refresh from Arweave", async () => {
    const { spyLogger } = createSpyLogger();
    const cache = new MemoryCacheClient();
    const arweaveClient = {
      getByTopic: sinon.stub().resolves([{ data: emptyPersistedBundle, hash: "tx-2" }]),
    };
    const bundleDataClient = new BundleDataClient(spyLogger, { arweaveClient } as any, {}, [], {}, cache);

    await cache.set(getArweaveTopicCacheKey(tag), '{"bundleDepositsV3":');

    const result = await (bundleDataClient as any).loadPersistedDataFromArweave(blockRanges);

    expect(result).to.deep.equal(emptyLoadDataResult);
    expect(arweaveClient.getByTopic.calledOnce).to.be.true;
  });
});
