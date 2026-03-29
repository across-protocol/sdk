import { TronWeb } from "tronweb";
import { PopulatedTransaction } from "ethers";
import { evmToTronAddress } from "./utils/address";

export interface TronTransactionResult {
  txid: string;
  result: boolean;
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
