import { array, defaulted, string, type } from "superstruct";
import { AdapterOptions } from "../types";
import { AbstractAdapter } from "./abstract";

const DEFAULT_NAME = "bybit";
const DEFAULT_URL = "https://hackscan.hackbounty.io/public/hack-address.json";

// This type is a bit message and unweildy. Additional fields representing new chains may be added without notification.
const bybitResponse = type({
  "0221": type({
    eth: defaulted(array(string()), []),
    bsc: defaulted(array(string()), []),
    arbi: defaulted(array(string()), []),
  }),
});

export class AddressList extends AbstractAdapter {
  constructor(opts?: AdapterOptions) {
    super(opts?.name ?? DEFAULT_NAME, opts?.path ?? DEFAULT_URL, opts);
  }

  async update(): Promise<string[]> {
    const response = await this.fetch(this.name, this.path, this.timeout, this.retries);
    if (!bybitResponse.is(response)) {
      // nb. don't log the response because it might be very large.
      return this.error("Failed to validate response");
    }

    return [...response["0221"].eth, ...response["0221"].bsc, ...response["0221"].arbi];
  }
}
