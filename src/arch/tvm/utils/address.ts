import { TronWeb } from "tronweb";

/**
 * Convert an EVM-format hex address (0x...) to a TRON Base58Check address (T...).
 * @param evmAddress The 0x-prefixed hex address.
 * @returns The TRON Base58Check-encoded address.
 */
export function evmToTronAddress(evmAddress: string): string {
  // TronWeb.address.fromHex expects a hex address (with or without 0x prefix)
  // and returns the Base58Check-encoded TRON address.
  return TronWeb.address.fromHex(evmAddress);
}

/**
 * Convert a TRON Base58Check address (T...) to an EVM-format hex address (0x...).
 * @param tronAddress The TRON Base58Check-encoded address.
 * @returns The 0x-prefixed hex address.
 */
export function tronToEvmAddress(tronAddress: string): string {
  // TronWeb.address.toHex returns hex with a 41 prefix (TRON's address prefix).
  // We strip the leading "41" and add "0x" to get standard EVM format.
  const hex = TronWeb.address.toHex(tronAddress);
  return "0x" + hex.slice(2);
}

/**
 * Check whether a string is a valid TRON Base58Check address.
 * @param address The string to check.
 * @returns True if the address is a valid TRON Base58Check address.
 */
export function isTronBase58Address(address: string): boolean {
  return TronWeb.isAddress(address);
}
