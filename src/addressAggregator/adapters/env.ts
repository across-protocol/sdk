import { array, defaulted, string } from "superstruct";
import { AddressListAdapter } from "../types";
import { Logger, logError } from "./util";

const envConfig = defaulted(array(string()), []);

export class AddressList implements AddressListAdapter {
  readonly name = "process.env";

  constructor(readonly envVar = "ACROSS_IGNORED_ADDRESSES") {}

  update(logger?: Logger): Promise<string[]> {
    const config = process.env[this.envVar];
    if (!config) {
      return Promise.resolve([]);
    }

    let addresses: unknown;
    try {
      addresses = JSON.parse(config);
      if (!envConfig.is(addresses)) {
        return logError(this.name, "Address format validation failure.", logger);
      }
    } catch (err) {
      return logError(this.name, err, logger);
    }

    return Promise.resolve(addresses);
  }
}
