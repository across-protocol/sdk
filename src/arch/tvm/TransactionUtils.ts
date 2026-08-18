import { TronWeb } from "tronweb";
import { PopulatedTransaction } from "ethers";
import { isDefined } from "../../utils/TypeGuards";
import { TvmAddress } from "../../utils/AddressUtils";

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
 * TRON models a native TRX transfer as its own transaction type (`TransferContract`), distinct from
 * the `TriggerSmartContract` used for calls. A populated transaction with no `data` field is
 * therefore dispatched to TronWeb's `sendTransaction` instead; see {@link transferNative}. Note that
 * this turns on `data` being absent, not empty: an explicit `"0x"` remains a contract call, since
 * that is how TronWeb encodes a `receive`/`fallback` invocation.
 *
 * @param tronWeb An authenticated TronWeb instance (with private key set).
 * @param populatedTx The populated transaction containing `to`, and `data` for a contract call.
 * @param feeLimit The maximum TRX to burn for energy consumption, in SUN (1 TRX = 1,000,000 SUN).
 * @returns The transaction ID and result status.
 */
export async function submitTransaction(
  tronWeb: TronWeb,
  populatedTx: PopulatedTransaction,
  feeLimit: number,
  callValue: number = 0
): Promise<TronTransactionResult> {
  const { to, data } = populatedTx;
  if (!to) {
    throw new Error("submitTransaction: populatedTx must have a 'to' field");
  }

  const tronAddress = TvmAddress.from(to).toNative();
  const ownerAddress = tronWeb.defaultAddress?.base58;
  if (!ownerAddress) {
    throw new Error("submitTransaction: TronWeb instance must have a default address configured");
  }

  // No calldata at all means this is a value transfer, which triggerSmartContract cannot express: it
  // requires a deployed contract at the target address, so it can never fund an EOA.
  //
  // Empty-but-present calldata ("0x") is deliberately *not* treated as a transfer. That is TronWeb's
  // own encoding for a `receive`/`fallback` selector, which it submits as a TriggerSmartContract; a
  // TransferContract would move the TRX without running the recipient's code.
  if (!isDefined(data)) {
    return transferNative(tronWeb, tronAddress, callValue);
  }

  // Use triggerSmartContract with the `input` option to pass pre-encoded calldata.
  // The function selector is empty — the full calldata (selector + params) is in `input`.
  const input = data.startsWith("0x") ? data.slice(2) : data;
  const txWrapper = await tronWeb.transactionBuilder.triggerSmartContract(
    tronAddress,
    // Use empty function selector — the `input` option provides the full calldata.
    "",
    { feeLimit, input, callValue },
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
 * Transfer native TRX to an account via a `TransferContract` transaction.
 *
 * TronWeb's `sendTransaction` builds, signs and broadcasts in one call, using the instance's default
 * private key. No fee limit applies, since transfers consume bandwidth rather than energy.
 *
 * @param tronWeb An authenticated TronWeb instance (with private key set).
 * @param recipient Base58 recipient address.
 * @param amount Transfer amount in SUN (1 TRX = 1,000,000 SUN).
 * @returns The transaction ID and result status.
 */
async function transferNative(tronWeb: TronWeb, recipient: string, amount: number): Promise<TronTransactionResult> {
  if (amount <= 0) {
    throw new Error("submitTransaction: a transaction with no calldata must transfer a non-zero value");
  }

  const broadcast = await tronWeb.trx.sendTransaction(recipient, amount);

  return {
    txid: broadcast.txid ?? broadcast.transaction.txID,
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
  feeLimit: number,
  callValue: number = 0
): Promise<TronSimulationResult> {
  const { to, data } = populatedTx;
  if (!to || !data) {
    throw new Error("simulateTransaction: populatedTx must have both 'to' and 'data' fields");
  }

  const tronAddress = TvmAddress.from(to).toNative();
  const ownerAddress = tronWeb.defaultAddress?.base58;
  if (!ownerAddress) {
    throw new Error("simulateTransaction: TronWeb instance must have a default address configured");
  }

  // `triggerConstantContract` is used to Invoke the readonly function (modified by the view or pure modifier) of a contract for contract data query;
  // or to Invoke the non-readonly function of a contract for predicting whether the transaction can be successfully executed
  // and estimating the energy consumption; or to estimate the energy consumption of contract deployment
  const input = data.startsWith("0x") ? data.slice(2) : data;
  const txWrapper = await tronWeb.transactionBuilder.triggerConstantContract(
    tronAddress,
    "",
    { feeLimit, input, callValue },
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
