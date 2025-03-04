import { readFile } from "node:fs/promises";
import { array, defaulted, string } from "superstruct";
import { AddressListAdapter } from "../types";
import { Logger, logError } from "./util";

const fileConfig = defaulted(array(string()), []);

export class AddressList implements AddressListAdapter {
  readonly name: string;

  constructor(readonly path = "./addresses.json") {
    this.name = `fs:${path}`;
  }

  async update(logger?: Logger): Promise<string[]> {
    let data: string;
    try {
      data = await readFile(this.path, { encoding: "utf8" });
    } catch (err) {
      return logError(this.name, err, logger);
    }

    if (!data) {
      return logError(this.name, `No addresses found in \"${this.path}\"`, logger);
    }

    let addresses: unknown;
    try {
      addresses = JSON.parse(data);
      if (!fileConfig.is(addresses)) {
        return logError(this.name, "Address format validation failure.", logger);
      }
    } catch (err) {
      return logError(this.name, err, logger);
    }

    return Promise.resolve(addresses);
  }
}
