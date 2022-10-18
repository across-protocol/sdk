import assert from "assert";
import axios, { AxiosError } from "axios";

export class BaseHTTPAdapter {
  private _timeout: number;

  get timeout(): number {
    return this._timeout;
  }

  set timeout(timeout: number) {
    assert(timeout >= 0);
    this._timeout = timeout;
  }

  constructor(public readonly name: string, public readonly host: string, { timeout }: { timeout?: number }) {
    this._timeout = timeout ?? 1000; // ms
  }

  protected async query(path: string, urlArgs?: object): Promise<unknown> {
    const url = `https://${this.host}/${path ?? ""}`;
    const args = {
      timeout: this._timeout,
      params: urlArgs ?? {},
    };

    const result = await axios(url, args).catch((err) => {
      const errMsg = err instanceof AxiosError ? err.message : err.toString();
      throw new Error(`${this.name} price lookup failure (${errMsg})`);
    });
    return result.data;
  }
}
