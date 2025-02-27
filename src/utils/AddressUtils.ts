import { providers, utils } from "ethers";
import bs58 from "bs58";
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

// The Address class can contain any address type. It is up to the subclasses to determine how to format the address's internal representation,
// which for this class, is a bytes32 hex string.
export class Address {
  constructor(readonly rawAddress: Uint8Array) {
    // No forced validation is done in this class, and therefore there are no guarantees here that the address will be well-defined on any network.
    // Instead, validation is done on the subclasses so that we can guarantee that, for example, an EvmAddress type will always contain a valid, 20-byte
    // EVM address.
  }

  static fromBase58(bs58Address: string): Address {
    return new Address(bs58.decode(bs58Address));
  }

  static fromHex(hexString: string): Address {
    return new Address(utils.arrayify(hexString));
  }

  // Converts an input hex data string into a bytes32 string. Note that the output bytes will be lowercase
  // so that it naturally matches with ethers event data.
  // Throws an error if the input string is already greater than 32 bytes.
  toBytes32(): string {
    return utils.hexZeroPad(utils.hexlify(this.rawAddress), 32).toLowerCase();
  }

  // Converts an input hex address (can be bytes32 or bytes20) to its base58 counterpart.
  toBase58(): string {
    return bs58.encode(this.rawAddress);
  }

  toAddress(): string {
    const hexString = utils.hexlify(this.rawAddress);
    const rawAddress = utils.hexZeroPad(utils.hexStripZeros(hexString), 20);
    return utils.getAddress(rawAddress);
  }

  // Checks if the input string can be coerced into a bytes20 evm address. Returns true if it is possible, and false otherwise.
  isValidEvmAddress(): boolean {
    try {
      this.toAddress();
      return true;
    } catch {
      return false;
    }
  }

  isValidSvmAddress(): boolean {
    try {
      this.toBase58();
      return true;
    } catch {
      return false;
    }
  }
}

export class EvmAddress extends Address {
  constructor(rawAddress: Uint8Array) {
    super(rawAddress);
    const hexString = utils.hexlify(rawAddress);
    if (!this.isValidEvmAddress()) {
      throw new Error(`${hexString} is neither a valid SVM nor a valid EVM address`);
    }
  }
}
