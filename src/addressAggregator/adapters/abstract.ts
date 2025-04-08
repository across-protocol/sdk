import axios from "axios";
import { AdapterOptions, AddressListAdapter } from "../types";
import { Logger } from "../../utils";

const { ACROSS_USER_AGENT = "across-protocol" } = process.env;

export abstract class AbstractAdapter implements AddressListAdapter {
  readonly timeout: number;
  readonly retries: number;
  readonly throw: boolean;
  readonly logger?: Logger;

  constructor(
    readonly name: string,
    readonly path: string,
    opts?: Omit<AdapterOptions, "name" | "path">
  ) {
    this.timeout = opts?.timeout ?? 2000;
    this.retries = opts?.retries ?? 1;
    this.throw = opts?.throwOnError ?? true;
    this.logger = opts?.logger;
  }

  abstract update(logger?: Logger): Promise<string[]>;

  protected sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
  }

  protected async fetch(name: string, url: string, timeout = 2000, retries = 1): Promise<unknown> {
    const args = {
      headers: { "User-Agent": ACROSS_USER_AGENT },
      timeout,
    };

    const errs: string[] = [];
    let tries = 0;
    do {
      try {
        return (await axios(url, args)).data;
      } catch (err) {
        const errMsg = axios.isAxiosError(err) || err instanceof Error ? err.message : "unknown error";
        errs.push(errMsg);
        if (++tries <= retries) await this.sleep(Math.pow(1.5, tries) * 1000); // simple backoff
      }
    } while (tries <= retries);

    throw new Error(`${name} retrieval failure (${errs.join(", ")})`);
  }

  protected error(error: unknown): Promise<string[]> {
    if (this.throw) {
      throw error;
    }

    let reason: string;
    if (error instanceof Error) {
      reason = error.message;
    } else {
      reason = typeof error === "string" ? error : "unknown error";
    }

    const { name, path, timeout, retries } = this;
    this.logger?.warn({
      at: `${name}::update`,
      message: `Failed to read addresses from ${name}.`,
      reason,
      path,
      retries,
      timeout,
    });
    return Promise.resolve([]);
  }
}
