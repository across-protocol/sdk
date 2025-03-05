import { array, defaulted, string, type } from "superstruct";
import { AddressListAdapter } from "../types";
import { logError, Logger, fetch } from "./util";

const DEFAULT_URL = "https://hackscan.hackbounty.io/public/hack-address.json";

// This type is a bit message and unweildy. Additional fields representing new chains may be added without notification.
const bybitResponse = type({
  "0221": type({
    eth: defaulted(array(string()), []),
    bsc: defaulted(array(string()), []),
    arbi: defaulted(array(string()), []),
  }),
});

export class AddressList implements AddressListAdapter {
  readonly timeout = 2000; // ms
  readonly retries = 1;
  readonly name = "bybit";

  constructor(readonly url = DEFAULT_URL) {}

  async update(logger?: Logger): Promise<string[]> {
    const response = await fetch(this.name, this.url, this.timeout, this.retries);
    if (!bybitResponse.is(response)) {
      // nb. don't log the response because it might be very large.
      return logError(this.name, "Failed to validate response", logger);
    }

    return [...response["0221"].eth, ...response["0221"].bsc, ...response["0221"].arbi];
  }
}
