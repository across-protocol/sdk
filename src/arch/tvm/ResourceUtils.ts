import { TronWeb } from "tronweb";
import type { ContractFunctionParameter } from "tronweb/lib/esm/types/TransactionBuilder";
import { evmToTronAddress } from "./utils/address";

export interface TronResourceEstimate {
  energyRequired: number;
  /** Recommended feeLimit in SUN (1 TRX = 1,000,000 SUN). */
  feeLimit: number;
}

export interface TronAccountResources {
  freeNetLimit: number;
  freeNetUsed: number;
  energyLimit: number;
  energyUsed: number;
}

// Safety multiplier applied to the estimated fee limit (1.2x).
const FEE_LIMIT_MULTIPLIER = 1.2;

/**
 * Query the current energy price in SUN per unit of energy.
 * @param tronWeb A TronWeb instance.
 * @returns The current energy price in SUN.
 */
async function getEnergyPrice(tronWeb: TronWeb): Promise<number> {
  // getEnergyPrices() returns a comma-separated string of "timestamp:price" pairs.
  // The last entry is the current price.
  const pricesStr = await tronWeb.trx.getEnergyPrices();
  const entries = pricesStr.split(",");
  const lastEntry = entries[entries.length - 1];
  const price = Number(lastEntry.split(":")[1]);

  if (!Number.isFinite(price) || price <= 0) {
    throw new Error(`getEnergyPrice: unexpected energy price: ${lastEntry}`);
  }

  return price;
}

/**
 * Estimate the energy cost and recommended feeLimit for a smart contract call.
 *
 * @param tronWeb An authenticated TronWeb instance.
 * @param contractAddress The target contract address (EVM hex or TRON Base58 format).
 * @param functionSelector The Solidity function selector (e.g., "transfer(address,uint256)").
 * @param parameters The function parameters in TronWeb's ContractFunctionParameter format.
 * @param ownerAddress The address that will execute the transaction (EVM hex or TRON Base58).
 * @returns The estimated energy required and recommended feeLimit in SUN.
 */
export async function estimateTransactionFee(
  tronWeb: TronWeb,
  contractAddress: string,
  functionSelector: string,
  parameters: ContractFunctionParameter[],
  ownerAddress: string
): Promise<TronResourceEstimate> {
  // Normalise addresses to TRON Base58 if they are in EVM hex format.
  const tronContractAddress = contractAddress.startsWith("0x") ? evmToTronAddress(contractAddress) : contractAddress;
  const tronOwnerAddress = ownerAddress.startsWith("0x") ? evmToTronAddress(ownerAddress) : ownerAddress;

  const [estimate, energyPrice] = await Promise.all([
    tronWeb.transactionBuilder.estimateEnergy(tronContractAddress, functionSelector, {}, parameters, tronOwnerAddress),
    getEnergyPrice(tronWeb),
  ]);

  const energyRequired = estimate.energy_required;

  // Calculate feeLimit: energy * price-per-unit, with a safety margin.
  const feeLimit = Math.ceil(energyRequired * energyPrice * FEE_LIMIT_MULTIPLIER);

  return { energyRequired, feeLimit };
}

/**
 * Query the current resource allocation and usage for an account.
 *
 * @param tronWeb A TronWeb instance.
 * @param address The account address (EVM hex or TRON Base58 format).
 * @returns The account's bandwidth and energy limits and usage.
 */
export async function getAccountResources(tronWeb: TronWeb, address: string): Promise<TronAccountResources> {
  const tronAddress = address.startsWith("0x") ? evmToTronAddress(address) : address;
  const resources = await tronWeb.trx.getAccountResources(tronAddress);

  return {
    freeNetLimit: resources.freeNetLimit ?? 0,
    freeNetUsed: resources.freeNetUsed ?? 0,
    energyLimit: resources.NetLimit ?? 0,
    energyUsed: resources.NetUsed ?? 0,
  };
}
