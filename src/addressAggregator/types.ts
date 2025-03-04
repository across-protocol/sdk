export interface AddressListAdapter {
  readonly name: string;
  update(): Promise<string[]>;
}

export const INVALID_ADDRESS = "";
