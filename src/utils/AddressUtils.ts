import { providers, utils } from "ethers";
import bs58 from "bs58";
import { BigNumber, chainIsEvm, chainIsSvm } from "./";

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

// Constructs a 20-byte checksummed EVM address from a hex string input.
// Throws an error if the underlying address length is longer than 20 bytes or incorrectly checksummed.
export function toEvmAddress(hexString: string): string {
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
 * @param chainId Chain ID for the intended use of the address.
 * @returns a child `Address` type most fitting for the chain ID.
 * @todo: Change this to `toAddress` once we remove the other `toAddress` function.
 */
export function toAddressType(address: string, chainId: number): Address {
  const rawAddress = address.startsWith("0x") ? utils.arrayify(address) : bs58.decode(address);

  if (chainIsEvm(chainId) && EvmAddress.validate(rawAddress)) return new EvmAddress(rawAddress);
  else if (chainIsSvm(chainId) && SvmAddress.validate(rawAddress)) return new SvmAddress(rawAddress);

  return new RawAddress(rawAddress);
}

// The Address class can contain any address type. It is up to the subclasses to determine how to format the address's internal representation,
// which for this class, is a bytes32 hex string.
export abstract class Address {
  readonly __address_type_brand = true;
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

  static isAddress(obj: unknown): obj is Address {
    return "__address_type_brand" in (obj as { __address_type_brand: boolean });
  }

  // Converts the address into a bytes32 string. Note that the output bytes will be lowercase so that it matches ethers event data. This function will never
  // throw since address length validation was done at construction time.
  toBytes32(): string {
    return (this.bytes32Address ??= utils.hexZeroPad(utils.hexlify(this.rawAddress), 32).toLowerCase());
  }

  // Returns last 20 bytes of Address as a hex string. Truncates if necessary. This function is useful for comparing some longer addresses(e.g. Solana) to Solidity events
  // that contain truncated `address` type as one of the fields
  truncateToBytes20(): string {
    // Take the last 20 bytes
    const bytes20 = this.rawAddress.slice(-20);
    return toEvmAddress(utils.hexlify(bytes20));
  }

  // Converts the address (can be bytes32 or bytes20) to its base58 counterpart. This conversion will always succeed, even if the input address is not valid on Solana,
  // as this address may be needed to represent an EVM address on Solana.
  toBase58(): string {
    return (this.svmAddress ??= bs58.encode(this.rawAddress));
  }

  // Converts the address to a BigNumber type.
  private toBigNumber(): BigNumber {
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
  toNative(): string {
    return this.toBytes32();
  }

  // Implements `Hexable` for `Address`. Needed for encoding purposes. This class is treated by default as a bytes32 primitive type, but can change for subclasses.
  toHexString(): string {
    return this.toBytes32();
  }

  // Checks if the address is valid on the given chain ID.
  isValidOn(chainId: number): boolean {
    if (chainIsEvm(chainId)) return EvmAddress.validate(this.rawAddress);
    if (chainIsSvm(chainId)) return SvmAddress.validate(this.rawAddress);
    return false;
  }

  // Converts the input address to a 32-byte hex data string.
  toString(): string {
    return this.toNative();
  }

  // Checks if the address is the zero address.
  isZeroAddress(): boolean {
    return utils.stripZeros(this.rawAddress).length === 0;
  }

  // Forces `rawAddress` to become an SvmAddress type. This will only throw if `rawAddress.length > 32`.
  forceSvmAddress(): SvmAddress {
    return SvmAddress.from(this.toBase58());
  }

  // Checks if the other address is equivalent to this address.
  eq(other: Address): boolean {
    return this.toString() === other.toString();
  }

  // Compares Addresses by first converting them to BigNumbers.
  // note: Intended for use when sorting like addresses.
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

  isEVM(): this is EvmAddress {
    return false;
  }

  isSVM(): this is SvmAddress {
    return false;
  }
}

// Subclass of address which strictly deals with 20-byte addresses. These addresses are guaranteed to be valid EVM addresses, so `toAddress` will always succeed.
export class EvmAddress extends Address {
  private readonly _type = "evm";

  // On construction, validate that the address can indeed be coerced into an EVM address. Throw immediately if it cannot.
  constructor(rawAddress: Uint8Array) {
    if (!EvmAddress.validate(rawAddress)) {
      throw new Error(`${utils.hexlify(rawAddress)} is not a valid EVM address`);
    }

    super(rawAddress);
    this._type; // tsc noUnusedLocals appeasement.
  }

  static validate(rawAddress: Uint8Array): boolean {
    return (
      rawAddress.length == 20 || (rawAddress.length === 32 && rawAddress.slice(0, 12).every((field) => field === 0))
    );
  }

  override isEVM(): this is EvmAddress {
    return true;
  }

  // Override `toAddress` to return the 20-byte representation address.
  override toNative(): string {
    return this.toEvmAddress();
  }

  // Constructs a new EvmAddress type.
  static from(address: string, encoding: "base58" | "base16" = "base16"): EvmAddress {
    return encoding === "base16" ? new this(utils.arrayify(address)) : new this(bs58.decode(address));
  }
}

// Subclass of address which strictly deals SVM addresses. These addresses are guaranteed to be valid SVM addresses, so `toBase58` will always produce a valid Solana address.
export class SvmAddress extends Address {
  private readonly _type = "svm";

  // On construction, validate that the address is a point on Curve25519. Throw immediately if it is not.
  constructor(rawAddress: Uint8Array) {
    if (!SvmAddress.validate(rawAddress)) {
      throw new Error(`${utils.hexlify(rawAddress)} is not a valid SVM address`); // @todo: Display as Base58?
    }

    super(rawAddress);
    this._type; // tsc noUnusedLocals appeasement.
  }

  static validate(rawAddress: Uint8Array): boolean {
    // Deliberately invalidate SVM addresses w/ the upper 12 bytes zeroed. These addresses are technically valid
    // but highly improbable and are much more likely to be a mistaken interpretation of an EVM address. Err on
    // the side of caution for the time being. Exception: Permit the zero address (i.e. for exclusiverRelayer).
    return (
      rawAddress.length === 32 &&
      (!rawAddress.slice(0, 12).every((field) => field === 0) || rawAddress.every((field) => field === 0))
    );
  }

  override isSVM(): this is SvmAddress {
    return true;
  }

  // Override the toAddress function for SVM addresses only since while they will never have a defined 20-byte representation. The base58 encoded addresses are also the encodings
  // used in TOKEN_SYMBOLS_MAP.
  override toNative(): string {
    return this.toBase58();
  }

  // Constructs a new SvmAddress type.
  static from(address: string, encoding: "base58" | "base16" = "base58"): SvmAddress {
    return encoding === "base58" ? new this(bs58.decode(address)) : new this(utils.arrayify(address));
  }
}

export class RawAddress extends Address {
  private readonly _type = "raw";

  constructor(rawAddress: Uint8Array) {
    super(rawAddress);
    this._type; // tsc noUnusedLocals appeasement.
  }
}
