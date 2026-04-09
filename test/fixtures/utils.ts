import hre from "hardhat";

/**
 * Minimal replacement for hardhat-deploy's createFixture.
 * Runs the setup function once, takes an evm_snapshot, and restores it on subsequent calls.
 */
export function createFixture<T>(setup: () => Promise<T>): () => Promise<T> {
  let result: T;
  let snapshotId: string;

  return async () => {
    if (snapshotId !== undefined) {
      await hre.network.provider.send("evm_revert", [snapshotId]);
      // evm_revert consumes the snapshot, so take a fresh one for the next call.
      snapshotId = (await hre.network.provider.send("evm_snapshot", [])) as string;
      return result;
    }

    result = await setup();
    snapshotId = (await hre.network.provider.send("evm_snapshot", [])) as string;
    return result;
  };
}
