export function gasPriceError(method: string, chainId: number, data: unknown): void {
  throw new Error(`Malformed ${method} response on chain ID ${chainId} (${JSON.stringify(data)})`);
}
