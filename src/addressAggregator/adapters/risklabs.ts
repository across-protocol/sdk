import { array, string } from "superstruct";
import { AdapterOptions } from "../types";
import { AbstractAdapter } from "./abstract";

const RESPONSE_TYPE = array(string());
const DEFAULT_NAME = "Risk Labs";
const DEFAULT_URL = "https://blacklist.risklabs.foundation/api/blacklist";

export class AddressList extends AbstractAdapter {
  constructor(opts?: AdapterOptions) {
    super(opts?.name ?? DEFAULT_NAME, opts?.path ?? DEFAULT_URL, opts);
  }

  async update(): Promise<string[]> {
    let response: unknown;
    try {
      response = await this.fetch(this.name, this.path, this.timeout, this.retries);
    } catch (err) {
      return this.error(err);
    }

    if (!RESPONSE_TYPE.is(response)) {
      return this.error("Failed to validate response");
    }

    return response;
  }
}
