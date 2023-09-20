import assert from "assert";
import { BigNumber, BigNumberish, Event } from "ethers";
import { isDefined } from "../utils";

/**
 * @dev Originally imported from @uma/sdk.
 * @dev This code is intended to support existing use of contracts/hubPool.ts and should not be used for new code.
 * @todo Refactor contracts/hubPool.ts to avoid the need for this.
 */

export type SerializableEvent = Omit<
  Event,
  "decode" | "removeListener" | "getBlock" | "getTransaction" | "getTransactionReceipt"
>;

// useful for maintaining balances from events
export type Balances = { [key: string]: string };

/**
 * Utility for maintaining records of a token balance.
 */
export function Balances(balances: Balances = {}) {
  function create(id: string, amount = "0") {
    assert(!has(id), "balance already exists");
    return set(id, amount);
  }

  function has(id: string) {
    return isDefined(balances[id]);
  }

  function set(id: string, amount: string) {
    balances[id] = amount;
    return amount;
  }

  function add(id: string, amount: BigNumberish) {
    return set(id, BigNumber.from(amount).add(getOrCreate(id)).toString());
  }

  function sub(id: string, amount: BigNumberish) {
    return set(id, BigNumber.from(getOrCreate(id)).sub(amount).toString());
  }

  function get(id: string) {
    assert(has(id), "balance does not exist");
    return balances[id];
  }

  function getOrCreate(id: string) {
    if (has(id)) return get(id);
    return create(id);
  }

  return { create, add, sub, get, balances, set, has, getOrCreate };
}
