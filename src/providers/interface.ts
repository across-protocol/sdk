export interface CrosschainProvider {
  getBlock(blockTag: number | string): Promise<unknown>;
  getNetworkId(): Promise<number>;
  getBlockNumber(): Promise<number>;
}
