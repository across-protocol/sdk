export interface CrosschainProvider {
  send(method: string, params: Array<unknown>): Promise<unknown>;
  getBlock(blockTag: number | string): Promise<unknown>;
  getNetworkId(): Promise<number>;
  getBlockNumber(): Promise<number>;
}
