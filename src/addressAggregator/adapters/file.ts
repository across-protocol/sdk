import { readFile } from "node:fs/promises";
import { array, defaulted, string } from "superstruct";
import { AdapterOptions } from "../types";
import { AbstractAdapter } from "./abstract";

const fileConfig = defaulted(array(string()), []);

export class AddressList extends AbstractAdapter {
  constructor(opts?: AdapterOptions) {
    const { path = "addresses.json" } = opts ?? {};
    super(opts?.name ?? `fs:${path}`, path, opts);
  }

  async update(): Promise<string[]> {
    let data: string;
    try {
      data = await readFile(this.path, { encoding: "utf8" });
    } catch (err) {
      return this.error(err);
    }

    if (!data) {
      return this.error("No addresses found");
    }

    let addresses: unknown;
    try {
      addresses = JSON.parse(data);
      if (!fileConfig.is(addresses)) {
        return this.error("Address format validation failure.");
      }
    } catch (err) {
      return this.error(err);
    }

    return Promise.resolve(addresses);
  }
}
