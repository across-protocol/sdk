import { array, defaulted, string } from "superstruct";
import { AdapterOptions } from "../types";
import { AbstractAdapter } from "./abstract";

const envConfig = defaulted(array(string()), []);

export class AddressList extends AbstractAdapter {
  constructor(opts?: AdapterOptions) {
    super(opts?.name ?? "process.env", opts?.path ?? "ACROSS_IGNORED_ADDRESSES", opts);
  }

  update(): Promise<string[]> {
    const config = process.env[this.path];
    if (!config) {
      return Promise.resolve([]);
    }

    let addresses: unknown;
    try {
      addresses = JSON.parse(config);
      if (!envConfig.is(addresses)) {
        return this.error("Address format validation failure.");
      }
    } catch (err) {
      return this.error(err);
    }

    return Promise.resolve(addresses);
  }
}
