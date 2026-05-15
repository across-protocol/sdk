/**
 * Thrown when the SVM gas-price oracle cannot determine a base fee for the
 * supplied message — most commonly because Solana's `getFeeForMessage` RPC
 * returned `{ value: null }` even after retrying with a confirmed blockhash.
 *
 * Callers can use `instanceof` to map this to a transient upstream-RPC error
 * (e.g. HTTP 502 / 503) rather than treating it as an unhandled exception.
 */
export class SvmGasPriceUnavailableError extends Error {
  constructor(message: string, opts?: { cause?: unknown }) {
    super(message, opts?.cause !== undefined ? { cause: opts.cause } : undefined);
    this.name = "SvmGasPriceUnavailableError";
  }
}
