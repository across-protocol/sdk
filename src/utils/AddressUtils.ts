import { providers, utils } from "ethers";
import assert from "assert";
import bs58 from "bs58";
import { Address as V2Address } from "@solana/kit";
import { BigNumber, chainIsEvm, chainIsSvm, isDefined } from "./";

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
 * If no chain ID is specified, then fallback to inference via the structure of the address string.
 * @returns a child `Address` type most fitting for the chain ID.
 */
export function toAddressType(address: string, chainId?: number): Address {
  if (isDefined(chainId)) {
    try {
      if (chainIsEvm(chainId)) {
        return EvmAddress.from(address);
      } else {
        assert(chainIsSvm(chainId));
        return SvmAddress.from(address);
      }
    } catch (e) {
      assert(utils.isHexString(address));
      assert(utils.hexDataLength(address) === 32);
      return RawAddress.from(utils.arrayify(address));
    }
  }

  try {
    if (utils.isHexString(address)) {
      return EvmAddress.from(address);
    }
    return SvmAddress.from(address);
  } catch (e) {
    // If we hit this block, then the validation for one of the child address classes failed. We still may want to keep this address in our state, so
    // return an unchecked address type.
    assert(utils.isHexString(address));
    assert(utils.hexDataLength(address) === 32);
    return RawAddress.from(utils.arrayify(address));
  }
}

// The Address class can contain any address type. It is up to the subclasses to determine how to format the address's internal representation,
// which for this class, is a bytes32 hex string.
export abstract class Address {
  readonly rawAddress: Uint8Array;

  // Keep all address types in cache so that we may lazily evaluate them when necessary.
  evmAddress: string | undefined = undefined;
  bytes32Address: string | undefined = undefined;
  svmAddress: string | undefined = undefined;
  bnAddress: BigNumber | undefined = undefined;

  protected constructor(_rawAddress: Uint8Array) {
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

  // Returns last 20 bytes of Address as a hex string. Truncates if necessary. This function is useful for comparing some longer addresses(e.g. Solana) to Solidity events
  // that contain truncated `address` type as one of the fields
  truncateToBytes20(): string {
    // Take the last 20 bytes
    const bytes20 = this.rawAddress.slice(-20);
    return toAddress(utils.hexlify(bytes20));
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

  // Formats Address to a native representation of the ecosystem it belongs to. E.g. checksummed 20 bytes for EVM, and base58-encoded 32 bytes for SVM
  abstract formatAsNativeAddress(): string;

  // Converts the address to a Buffer type.
  toBuffer(): Buffer {
    return Buffer.from(this.rawAddress);
  }

  // Implements `Hexable` for `Address`. Needed for encoding purposes. This class is treated by default as a bytes32 primitive type, but can change for subclasses.
  toHexString(): string {
    return this.toBytes32();
  }

  // Checks if the address is valid on the given chain ID.
  abstract isValidOn(chainId: number): boolean;

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

  // Small utility to convert an Address to a Solana Kit branded type.
  toV2Address(): V2Address<string> {
    return this.toBase58() as V2Address<string>;
  }

  // Functions below should only be used after `isEvmAddress` / `isSvmAddress` checks are performed. They throw if underlying type is incorrect
  abstract __unsafeStaticCastToSvmAddress(): SvmAddress;
  abstract __unsafeStaticCastToEvmAddress(): EvmAddress;

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

  static isEvmAddress(address: Address): boolean {
    return address instanceof EvmAddress;
  }

  static isSvmAddress(address: Address): boolean {
    return address instanceof SvmAddress;
  }
}

// Subclass of address which strictly deals with 20-byte addresses. These addresses are guaranteed to be valid EVM addresses, so `toAddress` will always succeed.
export class EvmAddress extends Address {
  // On construction, validate that the address can indeed be coerced into an EVM address. Throw immediately if it cannot.
  protected constructor(rawAddress: Uint8Array) {
    super(rawAddress);
    const hexString = utils.hexlify(rawAddress);
    if (!isValidEvmAddress(hexString)) {
      throw new Error(`${hexString} is not a valid EVM address`);
    }
  }

  // Formats the address as a valid EVM address. This function should never throw as constructor-check will have ensured we have a valid Evm address
  formatAsChecksummedEvmAddress(): string {
    const parseRawAddress = () => {
      const hexString = utils.hexlify(this.rawAddress);
      const rawAddress = utils.hexZeroPad(utils.hexStripZeros(hexString), 20);
      return utils.getAddress(rawAddress);
    };
    return (this.evmAddress ??= parseRawAddress());
  }

  // Override `formatAsNativeAddress` to return the 20-byte representation address.
  override formatAsNativeAddress(): string {
    return this.formatAsChecksummedEvmAddress();
  }

  override isValidOn(chainId: number): boolean {
    if (chainIsEvm(chainId)) {
      return true;
    }
    return false;
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

  override __unsafeStaticCastToSvmAddress(): SvmAddress {
    throw new Error("Cannot cast `EvmAddress` to `SvmAddress`.");
  }

  override __unsafeStaticCastToEvmAddress(): EvmAddress {
    return this;
  }
}

// Subclass of address which strictly deals SVM addresses. These addresses are guaranteed to be valid SVM addresses, so `toBase58` will always produce a valid Solana address.
export class SvmAddress extends Address {
  // TODO: the comment below was never implemented
  // On construction, validate that the address is a point on Curve25519. Throw immediately if it is not.
  protected constructor(rawAddress: Uint8Array) {
    super(rawAddress);
  }

  // Override the formatAsNativeAddress function for SVM addresses only since while they will never have a defined 20-byte representation. The base58 encoded addresses are also the encodings
  // used in TOKEN_SYMBOLS_MAP.
  override formatAsNativeAddress(): string {
    return this.toBase58();
  }

  override isValidOn(chainId: number): boolean {
    if (chainIsSvm(chainId)) {
      return true;
    }
    return false;
  }

  override __unsafeStaticCastToSvmAddress(): SvmAddress {
    return this;
  }

  override __unsafeStaticCastToEvmAddress(): EvmAddress {
    throw new Error("Cannot cast `SvmAddress` to `EvmAddress`.");
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

// `RawAddress` stores data for addresses that were deemed incorrect for their context (e.g. EVM-style address for SVM-side deposit recipient)
// OR addresses that have unknown context
export class RawAddress extends Address {
  static from(rawAddress: Uint8Array): RawAddress {
    return new this(rawAddress);
  }

  // TODO? Consider throwing here instead
  override formatAsNativeAddress(): string {
    return this.toBytes32();
  }

  // TODO? Good assumption?
  // @dev use false everywhere here. This address *technically* can be valid on some chain, but we don't want to allow any accidental uses of `InvalidAddress` beyond simple logging or converting to bytes32 or something
  override isValidOn(_chainId: number): boolean {
    return false;
  }

  override __unsafeStaticCastToSvmAddress(): SvmAddress {
    throw new Error("Cannot cast `InvalidAddress` to `SvmAddress`.");
  }

  override __unsafeStaticCastToEvmAddress(): EvmAddress {
    throw new Error("Cannot cast `InvalidAddress` to `EvmAddress`.");
  }
}
