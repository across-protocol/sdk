import { Contract } from "ethers";
import { paginatedEventQuery } from "../../utils";

/**
 * Query for EIP-1967 contract upgrade events.
 * @param contract A contract instance (must be a UUPS or transparent proxy that emits the Upgraded event).
 * @param startBlock Optional start of the block range (inclusive). Defaults to 0.
 * @param endBlock Optional end of the block range (inclusive). Defaults to latest.
 * @param maxLookBack Optional eth_getLogs chunk size. Required on RPCs that cap the range (e.g. Chainstack Tron).
 * @returns An array of block numbers at which upgrades occurred, sorted ascending.
 */
export async function get1967Upgrades(
  contract: Contract,
  startBlock?: number,
  endBlock?: number,
  maxLookBack?: number
): Promise<number[]> {
  const from = startBlock ?? 0;
  const to = endBlock ?? (await contract.provider.getBlockNumber());

  const events = await paginatedEventQuery(contract, contract.filters.Upgraded(), { from, to, maxLookBack });

  return events.map(({ blockNumber }) => blockNumber);
}
