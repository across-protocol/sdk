import { providers, utils } from "ethers";
import bs58 from "bs58";
import { PublicKey } from "@solana/web3.js";
import { Address as V2Address } from "@solana/kit";
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

// Converts an input hex data string into a bytes32 string. Note that the output bytes will be lowercase
// so that it naturally matches with ethers event data.
// Throws an error if the input string is already greater than 32 bytes.
export function toBytes32(address: string): string {
  return utils.hexZeroPad(address, 32).toLowerCase();
}

// Checks if the input string can be coerced into a bytes20 evm address. Returns true if it is possible, and false otherwise.
export function toAddress(hexString: string): string {
  // rawAddress is the address which is not properly checksummed.
  const rawAddress = utils.hexZeroPad(utils.hexStripZeros(hexString), 20);
  return utils.getAddress(rawAddress);
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

/**
 * Creates the proper address type given the input chain ID corresponding to the address's origin network.
 * @param address Stringified address type to convert. Can be either hex encoded or base58 encoded.
 * @param chainId Network ID corresponding to the input address, used to determine which address type to output.
 * @returns a child `Address` type most fitting for the chain ID.
 * @todo: Change this to `toAddress` once we remove the other `toAddress` function.
 */
export function toAddressType(address: string, chainId: number): Address | EvmAddress | SvmAddress {
  try {
    if (chainIsEvm(chainId)) {
      return EvmAddress.from(address);
    }
    return SvmAddress.from(address);
  } catch (e) {
    // If we hit this block, then the validation for one of the child address classes failed. We still may want to keep this address in our state, so
    // return an unchecked address type.
    return new Address(utils.arrayify(address));
  }
}

// The Address class can contain any address type. It is up to the subclasses to determine how to format the address's internal representation,
// which for this class, is a bytes32 hex string.
export class Address {
  readonly rawAddress: Uint8Array;

  // Keep all address types in cache so that we may lazily evaluate them when necessary.
  evmAddress: string | undefined = undefined;
  bytes32Address: string | undefined = undefined;
  svmAddress: string | undefined = undefined;
  bnAddress: BigNumber | undefined = undefined;

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

  // Converts the address into a bytes32 string. Note that the output bytes will be lowercase so that it matches ethers event data. This function will never
  // throw since address length validation was done at construction time.
  toBytes32(): string {
    return (this.bytes32Address ??= utils.hexZeroPad(utils.hexlify(this.rawAddress), 32).toLowerCase());
  }

  // Converts the address (can be bytes32 or bytes20) to its base58 counterpart. This conversion will always succeed, even if the input address is not valid on Solana,
  // as this address may be needed to represent an EVM address on Solana.
  toBase58(): string {
    return (this.svmAddress ??= bs58.encode(this.rawAddress));
  }

  // Converts the address to a BigNumber type.
  toBigNumber(): BigNumber {
    return (this.bnAddress ??= BigNumber.from(this.toBytes32()));
  }

  // Converts the address to a valid EVM address. If it is unable to convert the address to a valid EVM address for some reason, such as if this address
  // is longer than 20 bytes, then this function will throw an error.
  toEvmAddress(): string {
    const parseRawAddress = () => {
      const hexString = utils.hexlify(this.rawAddress);
      const rawAddress = utils.hexZeroPad(utils.hexStripZeros(hexString), 20);
      return utils.getAddress(rawAddress);
    };
    return (this.evmAddress ??= parseRawAddress());
  }

  // Converts the address to a hex string. This method should be overriden by subclasses to obtain more meaningful
  // address representations for the target chain ID.
  toAddress(): string {
    return this.toBytes32();
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

  // Checks if the address is valid on the given chain ID.
  isValidOn(chainId: number): boolean {
    if (chainIsEvm(chainId)) {
      return this.isValidEvmAddress();
    }
    // Assume the address is always valid on Solana.
    return true;
  }

  // Checks if the object is an address by looking at whether it has an Address constructor.
  static isAddress(obj: unknown): boolean {
    return obj instanceof this;
  }

  // Converts the input address to a 32-byte hex data string.
  toString(): string {
    return this.toHexString();
  }

  // Checks if the address is the zero address.
  isZeroAddress(): boolean {
    return utils.stripZeros(this.rawAddress).length === 0;
  }

  // Checks if the other address is equivalent to this address.
  eq(other: Address): boolean {
    return this.toString() === other.toString();
  }

  // Compares Addresses by first converting them to BigNumbers.
  compare(otherAddress: Address): 1 | -1 | 0 {
    // Convert address strings to BigNumbers and then sort numerical value of the BigNumber, which sorts the addresses
    // effectively by their hex value.
    const bnAddressA = this.toBigNumber();
    const bnAddressB = otherAddress.toBigNumber();
    if (bnAddressA.gt(bnAddressB)) {
      return 1;
    } else if (bnAddressA.lt(bnAddressB)) {
      return -1;
    } else {
      return 0;
    }
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

  // Override `toAddress` to return the 20-byte representation address.
  override toAddress(): string {
    return this.toEvmAddress();
  }

  // Constructs a new EvmAddress type.
  static from(address: string, encoding: "base16" | "base58" = "base16"): EvmAddress {
    if (encoding === "base16") {
      return new this(utils.arrayify(address));
    }

    const decodedAddress = bs58.decode(address);
    const padding = decodedAddress.subarray(0, 12);
    const evmAddress = decodedAddress.subarray(12);

    if (padding.length !== 12 || utils.stripZeros(padding).length !== 0 || evmAddress.length !== 20) {
      throw new Error(`Not a valid base58-encoded EVM address: ${address}`);
    }

    return new this(evmAddress);
  }
}

// Subclass of address which strictly deals SVM addresses. These addresses are guaranteed to be valid SVM addresses, so `toBase58` will always produce a valid Solana address.
export class SvmAddress extends Address {
  protected publicKey: PublicKey | undefined;
  // On construction, validate that the address is a point on Curve25519. Throw immediately if it is not.
  constructor(rawAddress: Uint8Array) {
    super(rawAddress);
  }

  // Override the toAddress function for SVM addresses only since while they will never have a defined 20-byte representation. The base58 encoded addresses are also the encodings
  // used in TOKEN_SYMBOLS_MAP.
  override toAddress(): string {
    return this.toBase58();
  }

  // Return a solana/web3.js PublicKey type.
  toPublicKey(): PublicKey {
    this.publicKey ??= new PublicKey(this.toBase58());
    return this.publicKey;
  }

  toV2Address(): V2Address<string> {
    return this.toBase58() as V2Address<string>;
  }

  // Constructs a new SvmAddress type.
  static from(address: string, encoding: "base58" | "base16" = "base58"): SvmAddress {
    if (encoding === "base58") {
      return new this(bs58.decode(address));
    }

    const decodedAddress = utils.arrayify(address);
    if (decodedAddress.length !== 32) {
      throw new Error(`Not a valid base16-encoded SVM address: ${address}`);
    }

    return new this(decodedAddress);
  }
}
