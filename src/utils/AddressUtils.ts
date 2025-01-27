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

export function isValidEvmAddress(address: string): boolean {
  if (utils.isAddress(address)) {
    return true;
  }
  // We may throw an error here if hexZeroPadFails. This will happen if the address to pad is greater than 20 bytes long, indicating
  // that the address had less than 12 leading zero bytes.
  // We may also throw at getAddress if the input cannot be converted into a checksummed EVM address for some reason.
  // For both cases, this indicates that the address cannot be casted as a bytes20 EVM address, so we should return false.
  try {
    const evmAddress = utils.hexZeroPad(utils.hexStripZeros(address), 20);
    return utils.isAddress(utils.getAddress(evmAddress));
  } catch (_e) {
    return false;
  }
}
