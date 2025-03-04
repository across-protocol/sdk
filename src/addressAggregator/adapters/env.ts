import { array, defaulted, string } from "superstruct";
import { AddressListAdapter } from "../types";

const envConfig = defaulted(array(string()), []);

export class AddressList implements AddressListAdapter {
  readonly name = "process.env";

  constructor(readonly envVar = "ACROSS_IGNORED_ADDRESSES") {}

  update(): Promise<string[]> {
    const invalidConfig = Promise.resolve([]);

    const config = process.env[this.envVar];
    if (!config) {
      return invalidConfig;
    }

    try {
      const addresses = JSON.parse(config);
      return envConfig.is(addresses) ? Promise.resolve(addresses) : invalidConfig;
    } catch {
      return invalidConfig;
    }
  }
}
