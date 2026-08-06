import { Provider } from "@ethersproject/abstract-provider";
import { averageBlockTime } from "../src/arch/evm";
import { expect } from "./utils";

// averageBlockTime memoises per chainId for 15 minutes, so every case needs a chain of its own. These are
// deliberately not real chain IDs: a known one would be pre-seeded in the cache, and an OP stack one would
// inherit Optimism's seeded average.
let nextChainId = 9_900_001;

const BLOCK_TIME = 12;
const GENESIS_TIMESTAMP = 1_700_000_000;

type FakeProvider = {
  provider: Provider;
  chainId: number;
  requestedBlocks: number[];
};

/**
 * A provider backed by a synthetic chain of `height + 1` blocks, spaced BLOCK_TIME apart. Supply a chainId
 * to present a second view of a chain already seen by averageBlockTime.
 */
function fakeProvider(height: number, chainId = nextChainId++): FakeProvider {
  const requestedBlocks: number[] = [];

  const provider = {
    getNetwork: () => Promise.resolve({ chainId, name: `chain-${chainId}` }),
    getBlockNumber: () => Promise.resolve(height),
    getBlock: (blockTag: number) => {
      requestedBlocks.push(blockTag);

      // Mirror ethers, which does not reject a negative block number but resolves it relative to the head,
      // clamping at genesis.
      const number = blockTag < 0 ? Math.max(height + blockTag, 0) : blockTag;
      return Promise.resolve(number > height ? null : { number, timestamp: GENESIS_TIMESTAMP + number * BLOCK_TIME });
    },
  } as unknown as Provider;

  return { provider, chainId, requestedBlocks };
}

describe("BlockUtils: averageBlockTime", () => {
  it("averages over the requested range when the chain is long enough to hold it", async () => {
    const { provider, requestedBlocks } = fakeProvider(5000);

    const { average, blockRange } = await averageBlockTime(provider);

    expect(average).to.equal(BLOCK_TIME);
    expect(blockRange).to.equal(120);
    // 10 blocks back off the head, then 120 back from there.
    expect(requestedBlocks).to.have.members([4870, 4990]);
  });

  it("honours an explicit highBlock and blockRange", async () => {
    const { provider, requestedBlocks } = fakeProvider(5000);

    const { average, blockRange } = await averageBlockTime(provider, { highBlock: 1000, blockRange: 50 });

    expect(average).to.equal(BLOCK_TIME);
    expect(blockRange).to.equal(50);
    expect(requestedBlocks).to.have.members([950, 1000]);
  });

  it("starts the window at genesis and divides by the range actually sampled", async () => {
    // 120 blocks exist, so the window can only reach back 109 blocks from the offset head, not 120.
    // Pre-clamp it ran from block -11, which ethers resolves against the head: the sample collapsed to
    // blocks 108-109 while the divisor stayed 120, reporting 1/120th of the real block time. Clamping the
    // window alone is not enough either -- dividing 109 blocks of history by 120 reports 10.9s/block.
    const { provider, requestedBlocks } = fakeProvider(119);

    const { average, blockRange } = await averageBlockTime(provider);

    expect(average).to.equal(BLOCK_TIME);
    expect(blockRange).to.equal(109);
    expect(requestedBlocks).to.have.members([0, 109]);
  });

  it("falls back to the head on a chain shorter than the head offset", async () => {
    // The offset guards against RPC providers lagging the head. With only 6 blocks it would instead put the
    // whole window at or before genesis and leave nothing to sample.
    const { provider, requestedBlocks } = fakeProvider(5);

    const { average, blockRange } = await averageBlockTime(provider);

    expect(average).to.equal(BLOCK_TIME);
    expect(blockRange).to.equal(5);
    expect(requestedBlocks).to.have.members([0, 5]);
  });

  it("samples a two-block chain", async () => {
    const { provider } = fakeProvider(1);

    const { average, blockRange } = await averageBlockTime(provider);

    expect(average).to.equal(BLOCK_TIME);
    expect(blockRange).to.equal(1);
  });

  it("rejects a chain with no block range to sample", async () => {
    // A single block carries no block time. Reporting 0 propagates as an Infinity block estimate into every
    // caller that divides by the average.
    const { provider } = fakeProvider(0);

    const error = await averageBlockTime(provider).then(
      () => undefined,
      (err: Error) => err
    );

    expect(error?.message).to.contain("no block range to sample");
  });

  it("does not memoise a rejected computation", async () => {
    const { provider, chainId } = fakeProvider(0);
    await averageBlockTime(provider).catch(() => undefined);

    // The same chain, once it has some history. A memoised failure would pin the bad answer for 15 minutes.
    const { average } = await averageBlockTime(fakeProvider(200, chainId).provider);

    expect(average).to.equal(BLOCK_TIME);
  });

  it("memoises per chain", async () => {
    const { provider, requestedBlocks } = fakeProvider(5000);

    const first = await averageBlockTime(provider);
    const second = await averageBlockTime(provider);

    expect(second).to.deep.equal(first);
    expect(requestedBlocks.length).to.equal(2); // Only the first call reached the provider.
  });
});
