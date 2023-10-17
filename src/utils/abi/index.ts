import * as fs from "fs/promises";
import { ContractInterface } from "ethers";
import { isError } from "../../typeguards";

/**
 * @dev To retrieve a new ABI, the following is useful:
 * CONTRACT_ADDRESS="0x1234..."
 * URL="http://api.etherscan.io/api?module=contract&action=getabi&format=raw&address=${CONTRACT_ADDRESS}"
 * curl -s "${URL}" | python -m json.tool > "./src/utils/abi/contracts/new-contract.json"
 */

/**
 * @notice Obtain the path to the local ABI JSON store.
 * @returns Fully-qualified path to the local ABI JSON store.
 */
export function getABIDir(): string {
  return `${__dirname}/contracts`;
}

/**
 * @notice Retrieve an ABI desription from the set of known contracts.
 * @param contractName Name of the contract ABI to retrieve.
 * @returns Contract ABI as an ethers ContractInterface type.
 */
export async function getABI(contractName: string): Promise<ContractInterface> {
  try {
    return JSON.parse(await fs.readFile(`${getABIDir()}/${contractName}.json`, { encoding: "utf8" }));
  } catch (err) {
    // @dev fs methods can return errors that are not Error objects (i.e. errno).
    const msg = isError(err) ? err.message : (err as Record<string, unknown>)?.code;
    throw new Error(`Unable to retrieve ${contractName} ABI (${msg ?? "unknown error"})`);
  }
}
