import { ChainId } from "../constants";

export type ClientConfig = {
  web3Providers: Record<ChainId, string>;
};

export const clientConfig: ClientConfig = {
  web3Providers: {},
};
