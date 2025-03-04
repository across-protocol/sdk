import { Logger } from "../utils";

export interface AddressListAdapter {
  readonly name: string;
  update(logger?: Logger): Promise<string[]>;
}

export const INVALID_ADDRESS = "";
