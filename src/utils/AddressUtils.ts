import { providers, utils } from "ethers";
import { BigNumber } from "./BigNumberUtils";

/**
 * Checks if a contract is deployed at the given address
 * @param address The ETH address to check
 * @param provider A valid Ethers.js provider
 * @returns A boolean indicating if a contract is deployed at the given address or not (true = contract, false = no contract)
 */
export async function isContractDeployedToAddress(address: string, provider: providers.Provider): Promise<boolean> {
  // A base case for if the address is null or malformed
  if (!address || !utils.isAddress(address)) {
    return false;
  }
  // Retrieve the code at the address
  const code = await provider.getCode(address);
  // If the code is not empty, then there is a contract at this address
  return code !== "0x";
}

export function compareAddresses(addressA: string, addressB: string): 1 | -1 | 0 {
  // Convert address strings to BigNumbers and then sort numerical value of the BigNumber, which sorts the addresses
  // effectively by their hex value.
  const bnAddressA = BigNumber.from(addressA);
  const bnAddressB = BigNumber.from(addressB);
  if (bnAddressA.gt(bnAddressB)) {
    return 1;
  } else if (bnAddressA.lt(bnAddressB)) {
    return -1;
  } else {
    return 0;
  }
}

export function compareAddressesSimple(addressA?: string, addressB?: string): boolean {
  if (addressA === undefined || addressB === undefined) {
    return false;
  }
  return addressA.toLowerCase() === addressB.toLowerCase();
}

// Converts an input hex data string into a bytes32 string. Note that the output bytes will be lowercase
// so that it naturally matches with ethers event data.
// Throws an error if the input string is already greater than 32 bytes.
export function toBytes32(address: string): string {
  return utils.hexZeroPad(address, 32).toLowerCase();
}

// Converts an input (assumed to be) bytes32 string into a bytes20 string.
// If the input is not a bytes32 but is less than type(uint160).max, then this function
// will still succeed.
// Throws an error if the string as an unsigned integer is greater than type(uint160).max.
export function toAddress(bytes32: string): string {
  // rawAddress is the address which is not properly checksummed.
  const rawAddress = utils.hexZeroPad(utils.hexStripZeros(bytes32), 20);
  return utils.getAddress(rawAddress);
}

// Checks if an input address is a 32-byte address or not.
export function isAddressBytes32(address: string): boolean {
  // If the address is not 32 bytes, then don't check.
  if (utils.hexDataLength(address) !== 32) return false;

  const strippedAddress = utils.hexStripZeros(address);
  return utils.isBytes(strippedAddress) && utils.hexDataLength(strippedAddress) > 20;
}
