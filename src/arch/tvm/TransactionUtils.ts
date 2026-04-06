import { TronWeb } from "tronweb";
import { PopulatedTransaction } from "ethers";
import { evmToTronAddress } from "./utils/address";

export interface TronTransactionResult {
  txid: string;
  result: boolean;
}

/** Result of an off-chain contract call via `triggerConstantContract` (no broadcast). */
export interface TronSimulationResult {
  success: boolean;
  message?: string;
  constantResult?: unknown;
  energyUsed?: number;
  energyRequired?: number;
  energyPenalty?: number;
}

/**
 * Submit a populated EVM transaction to TRON via TronWeb.
 *
 * The EVM `populateV3Relay()` already produces correct ABI-encoded calldata.
 * This function extracts `to` and `data` from the PopulatedTransaction,
 * converts the target address to TRON Base58 format, and uses TronWeb's
 * `triggerSmartContract` → `sign` → `sendRawTransaction` pipeline.
 *
 * @param tronWeb An authenticated TronWeb instance (with private key set).
 * @param populatedTx The populated transaction containing `to` and `data`.
 * @param feeLimit The maximum TRX to burn for energy consumption, in SUN (1 TRX = 1,000,000 SUN).
 * @returns The transaction ID and result status.
 */
export async function submitTransaction(
  tronWeb: TronWeb,
  populatedTx: PopulatedTransaction,
  feeLimit: number
): Promise<TronTransactionResult> {
  const { to, data } = populatedTx;
  if (!to || !data) {
    throw new Error("submitTransaction: populatedTx must have both 'to' and 'data' fields");
  }

  const tronAddress = evmToTronAddress(to);
  const ownerAddress = tronWeb.defaultAddress?.base58;
  if (!ownerAddress) {
    throw new Error("submitTransaction: TronWeb instance must have a default address configured");
  }

  // Use triggerSmartContract with the `input` option to pass pre-encoded calldata.
  // The function selector is empty — the full calldata (selector + params) is in `input`.
  const txWrapper = await tronWeb.transactionBuilder.triggerSmartContract(
    tronAddress,
    // Use empty function selector — the `input` option provides the full calldata.
    "",
    { feeLimit, input: data },
    [],
    ownerAddress
  );

  if (!txWrapper?.result?.result) {
    const message = txWrapper?.result?.message ?? "Unknown error";
    throw new Error(`submitTransaction: triggerSmartContract failed: ${message}`);
  }

  const signedTx = await tronWeb.trx.sign(txWrapper.transaction);
  const broadcast = await tronWeb.trx.sendRawTransaction(signedTx);

  return {
    txid: broadcast.txid ?? signedTx.txID,
    result: broadcast.result ?? false,
  };
}

/**
 * Simulate a populated EVM transaction against TRON via TronWeb (constant call / `eth_call`-style).
 *
 * Same calldata path as {@link submitTransaction}: `to` and `data` from the populated tx,
 * EVM `to` converted to TRON Base58, empty function selector with `{ input: data }`.
 * Does not sign or broadcast.
 *
 * @param tronWeb TronWeb instance with a default address (used as `caller`).
 * @param populatedTx Must contain `to` and `data`.
 * @param feeLimit Maximum TRX for energy, in SUN (mirrors `submitTransaction`).
 */
export async function simulateTransaction(
  tronWeb: TronWeb,
  populatedTx: PopulatedTransaction,
  feeLimit: number
): Promise<TronSimulationResult> {
  const { to, data } = populatedTx;
  if (!to || !data) {
    throw new Error("simulateTransaction: populatedTx must have both 'to' and 'data' fields");
  }

  const tronAddress = evmToTronAddress(to);
  const ownerAddress = tronWeb.defaultAddress?.base58;
  if (!ownerAddress) {
    throw new Error("simulateTransaction: TronWeb instance must have a default address configured");
  }

  // `triggerConstantContract` is used to Invoke the readonly function (modified by the view or pure modifier) of a contract for contract data query;
  // or to Invoke the non-readonly function of a contract for predicting whether the transaction can be successfully executed
  // and estimating the energy consumption; or to estimate the energy consumption of contract deployment
  const txWrapper = await tronWeb.transactionBuilder.triggerConstantContract(
    tronAddress,
    "",
    { feeLimit, input: data },
    [],
    ownerAddress
  );

  const success = txWrapper?.result?.result === true;

  return {
    success,
    message: txWrapper?.result?.message,
    constantResult: txWrapper?.constant_result,
    energyUsed: txWrapper?.energy_used,
    energyRequired: txWrapper?.energy_required,
    energyPenalty: txWrapper?.energy_penalty,
  };
}
