import { Logger } from "../utils";

export type AdapterOptions = {
  name?: string;
  path?: string;
  retries?: number;
  timeout?: number;
  throwOnError?: boolean;
  logger?: Logger;
};

export interface AddressListAdapter {
  readonly name: string;
  update(): Promise<string[]>;
}

export const INVALID_ADDRESS = "";
