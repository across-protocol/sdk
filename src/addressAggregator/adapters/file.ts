import { readFile } from "node:fs/promises";
import { array, defaulted, string } from "superstruct";
import { AddressListAdapter } from "../types";

const fileConfig = defaulted(array(string()), []);

export class AddressList implements AddressListAdapter {
  readonly name: string;

  constructor(readonly path = "./addresses.json") {
    this.name = `fs:${path}`;
  }

  async update(): Promise<string[]> {
    const invalidConfig = Promise.resolve([]);

    let data: string;
    try {
      data = await readFile(this.path, { encoding: "utf8" });
    } catch {
      console.log(`error on filename`);
      return invalidConfig;
    }

    if (!data) {
      console.log(`error no data`);
      return invalidConfig;
    }

    let addresses: unknown;
    try {
      addresses = JSON.parse(data);
      return fileConfig.is(addresses) ? Promise.resolve(addresses) : invalidConfig;
    } catch {
      console.log(`error bad JSON`);
      return invalidConfig;
    }
  }
}
