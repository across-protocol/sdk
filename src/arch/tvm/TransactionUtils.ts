import { TronWeb, Types } from "tronweb";
import { PopulatedTransaction } from "ethers";
import { hexToUtf8, isDefined, TvmAddress } from "../../utils";

// TRON's response_code for a transaction the node has already seen. The broadcast is redundant
// rather than failed: that txid is in the mempool or already in a block, so it is reported as a
// successful send, mirroring EVM nodes, where an "already known" resubmission resolves to the
// incumbent hash.
const DUP_TRANSACTION_ERROR = "DUP_TRANSACTION_ERROR";

// `response_code` reaches us in either of two forms: a TRON HTTP node returns the name, while
// TronWeb's typings declare the protocol's numeric enum. Ordinals are mapped back to the name so
// that a caller reading `code` — and the DUP_TRANSACTION_ERROR test below — sees one form only.
// Mirrors `BroadcastReturn_response_code` in tronweb/src/types/Trx.ts, which is not exported.
const BROADCAST_RESPONSE_CODES: Record<number, string> = {
  0: "SUCCESS",
  1: "SIGERROR",
  2: "CONTRACT_VALIDATE_ERROR",
  3: "CONTRACT_EXE_ERROR",
  4: "BANDWITH_ERROR", // TRON's own spelling.
  5: DUP_TRANSACTION_ERROR,
  6: "TAPOS_ERROR",
  7: "TOO_BIG_TRANSACTION_ERROR",
  8: "TRANSACTION_EXPIRATION_ERROR",
  9: "SERVER_BUSY",
  10: "NO_CONNECTION",
  11: "NOT_ENOUGH_EFFECTIVE_CONNECTION",
  20: "OTHER_ERROR",
};

/** A broadcast the node accepted: it holds this txid, in its mempool or already in a block. */
export interface TronTransactionSuccess {
  txid: string;
  result: true;
}

/** A broadcast the node rejected, annotated with whatever reason it gave. */
export interface TronTransactionFailure {
  txid: string;
  result: false;
  /**
   * TRON `response_code`, resolved to its name (e.g. "TAPOS_ERROR"). Optional because a node need
   * not send one — a rejection is never inferred from its absence, only from `result: false`.
   */
  code?: string;
  /** The node's rejection reason, utf8-decoded where TRON hex-encoded it. */
  message?: string;
}

/**
 * Discriminated on `result`, so `code` and `message` are reachable only where they can exist. The
 * txid is common to both: it is fixed at signing and is reported whatever the node decides.
 */
export type TronTransactionResult = TronTransactionSuccess | TronTransactionFailure;

/**
 * Thrown when an already-signed transaction could not be handed to the network: the send itself
 * failed (transport error, timeout, malformed response), so whether the node took it is unknown.
 *
 * The transaction is signed by that point, so its `txid` is final and is carried here. TRON has no
 * nonce, so a blind resubmit is a second, independent transaction rather than a replacement —
 * callers must treat this as *possibly sent* and reconcile `txid` on-chain before submitting
 * anything else.
 *
 * Prefer {@link isTronBroadcastError} over `instanceof`: the SDK ships both CJS and ESM builds, and
 * a consumer that loads both does not share this class identity across them.
 */
export class TronBroadcastError extends Error {
  readonly txid: string;

  constructor(message: string, txid: string, opts?: { cause?: unknown }) {
    super(message, opts?.cause !== undefined ? { cause: opts.cause } : undefined);
    this.name = "TronBroadcastError";
    this.txid = txid;
  }
}

/** Structural type guard for {@link TronBroadcastError}; see the note on that class. */
export function isTronBroadcastError(error: unknown): error is TronBroadcastError {
  return (
    error instanceof TronBroadcastError ||
    (error instanceof Error &&
      error.name === "TronBroadcastError" &&
      typeof (error as TronBroadcastError).txid === "string")
  );
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
 * therefore built as a transfer instead; see {@link transferNative}. Note that this turns on `data`
 * being absent, not empty: an explicit `"0x"` remains a contract call, since that is how TronWeb
 * encodes a `receive`/`fallback` invocation.
 *
 * Both paths sign before broadcasting, so from that point on the txid is known locally and is
 * always reported: on a rejected send it accompanies `result: false`, and on a send that throws it
 * is carried by the {@link TronBroadcastError}. See {@link broadcastSignedTransaction}.
 *
 * @param tronWeb An authenticated TronWeb instance (with private key set).
 * @param populatedTx The populated transaction containing `to`, and `data` for a contract call.
 * @param feeLimit The maximum TRX to burn for energy consumption, in SUN (1 TRX = 1,000,000 SUN).
 * @returns The transaction ID, result status, and the node's code/message on a rejected broadcast.
 * @throws {TronBroadcastError} If the broadcast throws after signing; the transaction may be live.
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
    return transferNative(tronWeb, ownerAddress, tronAddress, callValue);
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
  return broadcastSignedTransaction(tronWeb, signedTx);
}

/**
 * Transfer native TRX to an account via a `TransferContract` transaction.
 *
 * No fee limit applies, since transfers consume bandwidth rather than energy. TronWeb's
 * `trx.sendTransaction` would fuse build, sign and broadcast into one call; the three steps are
 * kept apart here so that the signed transaction's txid outlives a failing broadcast, exactly as on
 * the contract-call path.
 *
 * @param tronWeb An authenticated TronWeb instance (with private key set).
 * @param owner Base58 sender address.
 * @param recipient Base58 recipient address.
 * @param amount Transfer amount in SUN (1 TRX = 1,000,000 SUN); must be a positive whole number.
 * @returns The transaction ID, result status, and the node's code/message on a rejected broadcast.
 */
async function transferNative(
  tronWeb: TronWeb,
  owner: string,
  recipient: string,
  amount: number
): Promise<TronTransactionResult> {
  if (amount <= 0) {
    throw new Error("submitTransaction: a transaction with no calldata must transfer a non-zero value");
  }

  // SUN is indivisible, and `transactionBuilder.sendTrx` validates the amount only *after* running
  // it through `parseInt()` — so a fractional amount is silently truncated and the recipient is
  // short-changed rather than the call being rejected. `trx.sendTransaction`, which this path
  // replaced, rejected it outright; keep doing so. The contract-call path needs no equivalent
  // guard: TronWeb validates `callValue` as an integer before it builds the transaction.
  if (!Number.isInteger(amount)) {
    throw new Error(`submitTransaction: transfer amount must be a whole number of SUN, got ${amount}`);
  }

  const txn = await tronWeb.transactionBuilder.sendTrx(recipient, amount, owner);
  const signedTx = await tronWeb.trx.sign(txn);
  return broadcastSignedTransaction(tronWeb, signedTx);
}

/**
 * Broadcast an already-signed transaction and translate the node's response.
 *
 * The txid is fixed at signing, so it survives every exit from this function: a send that throws is
 * rethrown as a {@link TronBroadcastError} carrying it, and a rejected send returns it alongside
 * the node's code. Dropping it would strand a transaction that may well be on-chain and — TRON
 * having no nonce to replace through — the resubmission would execute a second time.
 *
 * @param tronWeb An authenticated TronWeb instance.
 * @param signedTx The signed transaction to broadcast.
 * @returns The transaction ID, result status, and the node's code/message on a rejected broadcast.
 * @throws {TronBroadcastError} If the send throws; the transaction may or may not have been sent.
 */
async function broadcastSignedTransaction<T extends Types.SignedTransaction>(
  tronWeb: TronWeb,
  signedTx: T
): Promise<TronTransactionResult> {
  const { txID } = signedTx;

  let broadcast: Types.BroadcastReturn<T>;
  try {
    broadcast = await tronWeb.trx.sendRawTransaction(signedTx);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new TronBroadcastError(`TRON broadcast failed for ${txID}; it may still have been sent: ${reason}`, txID, {
      cause: error,
    });
  }

  // A rejected broadcast may omit txid; the locally-computed txID is authoritative either way.
  const txid = broadcast.txid ?? txID;
  if (broadcast.result) {
    return { txid, result: true };
  }

  const code = normalizeBroadcastCode(broadcast.code);

  // A duplicate is not a failed send: the node is holding this exact transaction.
  if (code === DUP_TRANSACTION_ERROR) {
    return { txid, result: true };
  }

  const message = decodeBroadcastMessage(broadcast.message);
  return { txid, result: false, ...(isDefined(code) && { code }), ...(isDefined(message) && { message }) };
}

/**
 * Resolve a broadcast `response_code` to its TRON name, whichever form the node sent it in.
 *
 * Neither form can be assumed: a TRON HTTP node returns the name, TronWeb's typings declare the
 * numeric enum, and an intermediary may pass the ordinal through as a string. An unrecognised code
 * is preserved rather than dropped, so a caller always sees whatever the node actually said.
 *
 * @param code The raw `code` from the broadcast response; typed `unknown` because the declared type
 *  is precisely what cannot be relied on here.
 * @returns The response-code name, or undefined when the node sent none.
 */
function normalizeBroadcastCode(code: unknown): string | undefined {
  if (!isDefined(code)) {
    return undefined;
  }

  const ordinal =
    typeof code === "number" ? code : typeof code === "string" && /^\d+$/.test(code) ? Number(code) : undefined;
  if (isDefined(ordinal)) {
    return BROADCAST_RESPONSE_CODES[ordinal] ?? String(ordinal);
  }

  const name = String(code);
  return name === "" ? undefined : name;
}

/**
 * TRON hex-encodes the rejection reason on a broadcast response. Decode it where it is valid utf8
 * hex and fall back to the raw value otherwise — a diagnostic must never mask the failure it
 * describes.
 */
function decodeBroadcastMessage(message?: string): string | undefined {
  if (!isDefined(message) || message === "") {
    return undefined;
  }

  try {
    return hexToUtf8(message.startsWith("0x") ? message : `0x${message}`);
  } catch {
    return message;
  }
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
