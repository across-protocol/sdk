import { array, string } from "superstruct";
import { AddressListAdapter } from "../types";
import { logError, Logger, fetch } from "./util";

const RESPONSE_TYPE = array(string());
const DEFAULT_NAME = "Risk Labs";
const DEFAULT_URL = "https://blacklist.risklabs.foundation/api/blacklist";

export class AddressList implements AddressListAdapter {
  readonly timeout = 2000; // ms
  readonly retries = 1;

  constructor(
    readonly name = DEFAULT_NAME,
    readonly url = DEFAULT_URL
  ) {}

  async update(logger?: Logger): Promise<string[]> {
    const response = await fetch(this.name, this.url, this.timeout, this.retries);

    if (!RESPONSE_TYPE.is(response)) {
      return logError(this.name, "Failed to validate response", logger);
    }

    return response;
  }
}
