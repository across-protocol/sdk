import sinon from "sinon";
import { Clients, LoadDataReturnValue } from "../src/interfaces";
import { expect, createSpyLogger } from "./utils";
import { BundleDataClient } from "../src/clients/BundleDataClient";
import { MemoryCacheClient } from "../src/caching";
import { getArweaveTopicCacheKey } from "../src/utils";

type ArweaveClientTopicReader = Pick<Clients["arweaveClient"], "getByTopic">;

type BundleDataClientTestAccess = BundleDataClient & {
  loadPersistedDataFromArweave(blockRangesForChains: number[][]): Promise<LoadDataReturnValue | undefined>;
};

function makeClients(arweaveClient: ArweaveClientTopicReader): Clients {
  return { arweaveClient: arweaveClient as unknown as Clients["arweaveClient"] } as unknown as Clients;
}

function loadPersistedDataFromArweave(
  bundleDataClient: BundleDataClient,
  blockRangesForChains: number[][]
): Promise<LoadDataReturnValue | undefined> {
  return (bundleDataClient as unknown as BundleDataClientTestAccess).loadPersistedDataFromArweave(blockRangesForChains);
}

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
    const bundleDataClient = new BundleDataClient(spyLogger, makeClients(arweaveClient), {}, [], {}, cache);

    await cache.set(getArweaveTopicCacheKey(tag), JSON.stringify(emptyPersistedBundle));

    const result = await loadPersistedDataFromArweave(bundleDataClient, blockRanges);

    expect(result).to.deep.equal(emptyLoadDataResult);
    expect(arweaveClient.getByTopic.called).to.be.false;
  });

  it("should backfill the topic cache after a successful Arweave read", async () => {
    const { spyLogger } = createSpyLogger();
    const cache = new MemoryCacheClient();
    const arweaveClient = {
      getByTopic: sinon.stub().resolves([{ data: emptyPersistedBundle, hash: "tx-1" }]),
    };
    const bundleDataClient = new BundleDataClient(spyLogger, makeClients(arweaveClient), {}, [], {}, cache);

    const result = await loadPersistedDataFromArweave(bundleDataClient, blockRanges);
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
    const bundleDataClient = new BundleDataClient(spyLogger, makeClients(arweaveClient), {}, [], {}, cache);

    await cache.set(getArweaveTopicCacheKey(tag), '{"bundleDepositsV3":');

    const result = await loadPersistedDataFromArweave(bundleDataClient, blockRanges);

    expect(result).to.deep.equal(emptyLoadDataResult);
    expect(arweaveClient.getByTopic.calledOnce).to.be.true;
  });
});
