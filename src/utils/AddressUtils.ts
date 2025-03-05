import { providers, utils } from "ethers";
import bs58 from "bs58";
import { isAddress as isSvmAddress } from "@solana/web3.js";
import { BigNumber, chainIsEvm } from "./";

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

// Constructs the appropriate Address type given an input string and chain ID.
export function toAddress(address: string, chainId: number, forceCoercion = true): Address {
  if (!forceCoercion) {
    return Address.from(address);
  }
  if (chainIsEvm(chainId)) {
    return EvmAddress.from(address);
  }
  return SvmAddress.from(address);
}

// The Address class can contain any address type. It is up to the subclasses to determine how to format the address's internal representation,
// which for this class, is a bytes32 hex string.
export class Address {
  readonly rawAddress;
  constructor(_rawAddress: Uint8Array) {
    // The only validation done here is checking that the address is at most a 32-byte address, which  will be well-defined on any supported network.
    // Further validation is done on the subclasses so that we can guarantee that, for example, an EvmAddress type will always contain a valid, 20-byte
    // EVM address.
    if (_rawAddress.length > 32) {
      throw new Error(`Address ${utils.hexlify(_rawAddress)} cannot be longer than 32 bytes.`);
    }
    // Ensure all addresses in this class are internally stored as 32 bytes.
    this.rawAddress = utils.zeroPad(_rawAddress, 32);
  }

  // Constructs a new Address type given an input base58 string. Performs no validation.
  static fromBase58(bs58Address: string): Address {
    return new this(bs58.decode(bs58Address));
  }

  // Constructs a new Address type given an input hex string (of arbitrary length). Performs no validation.
  static fromHex(hexString: string): Address {
    return new this(utils.arrayify(hexString));
  }

  // Constructs a new Address type by attempting to infer the input string's format.
  static from(address: string): Address {
    if (utils.isHexString(address)) {
      return this.fromHex(address);
    }
    return this.fromBase58(address);
  }

  // Converts the address into a bytes32 string. Note that the output bytes will be lowercase  so that it matches ethers event data. This function will never
  // throw since address length validation was done at construction time.
  toBytes32(): string {
    return utils.hexZeroPad(utils.hexlify(this.rawAddress), 32).toLowerCase();
  }

  // Converts the address (can be bytes32 or bytes20) to its base58 counterpart. This conversion will always succeed, even if the input address is not valid on Solana,
  // as this address may be needed to represent an EVM address on Solana.
  toBase58(): string {
    return bs58.encode(this.rawAddress);
  }

  // Converts the address to a valid EVM address. If it is unable to convert the address to a valid EVM address for some reason, such as if this address
  // is longer than 20 bytes, then this function will throw an error.
  toAddress(): string {
    const hexString = utils.hexlify(this.rawAddress);
    const rawAddress = utils.hexZeroPad(utils.hexStripZeros(hexString), 20);
    return utils.getAddress(rawAddress);
  }

  // Implements `Hexable` for `Address`. Needed for encoding purposes. This class is treated by default as a bytes32 primitive type, but can change for subclasses.
  toHexString(): string {
    return this.toBytes32();
  }

  // Checks if this address can be coerced into a bytes20 evm address. Returns true if it is possible and false otherwise.
  isValidEvmAddress(): boolean {
    try {
      this.toAddress();
      return true;
    } catch {
      return false;
    }
  }

  // Checks if this address can be coerced into a valid Solana address. Return true if possible and false otherwise.
  isValidSvmAddress(): boolean {
    return isSvmAddress(this.toBase58());
  }

  // Checks if the address is valid on the given chain ID.
  isValidOn(chainId: number): boolean {
    if (chainIsEvm(chainId)) {
      return this.isValidEvmAddress();
    }
    return this.isValidSvmAddress();
  }

  // Checks if the object is an address by looking at whether it has an Address constructor.
  static isAddress(obj: Record<string, unknown>): boolean {
    return obj instanceof Address;
  }

  // Converts the input address to a 32-byte hex data string.
  toString(): string {
    return this.toBytes32();
  }

  // Checks if the address is the zero address.
  isZeroAddress(): boolean {
    return utils.stripZeros(this.rawAddress).length === 0;
  }

  // Checks if the other address is equivalent to this address.
  eq(other: Address): boolean {
    return this.toString() === other.toString();
  }
}

// Subclass of address which strictly deals with 20-byte addresses. These addresses are guaranteed to be valid EVM addresses, so `toAddress` will always succeed.
export class EvmAddress extends Address {
  // On construction, validate that the address can indeed be coerced into an EVM address. Throw immediately if it cannot.
  constructor(rawAddress: Uint8Array) {
    super(rawAddress);
    const hexString = utils.hexlify(rawAddress);
    if (!this.isValidEvmAddress()) {
      throw new Error(`${hexString} is not a valid EVM address`);
    }
  }
}

// Subclass of address which strictly deals SVM addresses. These addresses are guaranteed to be valid SVM addresses, so `toBase58` will always produce a valid Solana address.
export class SvmAddress extends Address {
  // On construction, validate that the address is a point on Curve25519. Throw immediately if it is not.
  constructor(rawAddress: Uint8Array) {
    super(rawAddress);
    if (!this.isValidSvmAddress()) {
      throw new Error(`${this} is not a valid SVM address`);
    }
  }

  // Override the toAddress function for SVM addresses only since while they will never have a defined 20-byte representation. The base58 encoded addresses are also the encodings
  // used in TOKEN_SYMBOLS_MAP.
  override toAddress(): string {
    return this.toBase58();
  }
}
