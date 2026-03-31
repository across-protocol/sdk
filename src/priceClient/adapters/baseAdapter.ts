import assert from "assert";

export type BaseHTTPAdapterArgs = {
  timeout?: number;
  retries?: number;
};

export class BaseHTTPAdapter {
  private _retries = 0;
  private _timeout = 0;

  get retries(): number {
    return this._retries;
  }

  set retries(retries: number) {
    assert(retries >= 0);
    this._retries = retries;
  }

  get timeout(): number {
    return this._timeout;
  }

  set timeout(timeout: number) {
    assert(timeout >= 0);
    this._timeout = timeout;
  }

  constructor(
    public readonly name: string,
    public readonly host: string,
    { timeout = 1000, retries = 1 }: BaseHTTPAdapterArgs
  ) {
    this.retries = retries;
    this.timeout = timeout; // ms
  }

  protected async query(path: string, urlArgs?: object): Promise<unknown> {
    const url = `https://${this.host}/${path ?? ""}`;
    const params = new URLSearchParams();
    if (urlArgs) {
      for (const [key, value] of Object.entries(urlArgs)) {
        params.append(key, String(value));
      }
    }
    const queryString = params.toString();
    const fullUrl = queryString ? `${url}?${queryString}` : url;

    const errs: string[] = [];
    let tries = 0;
    do {
      try {
        const response = await fetch(fullUrl, {
          headers: { "User-Agent": process.env.ACROSS_USER_AGENT ?? "across-protocol" },
          signal: AbortSignal.timeout(this.timeout),
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        return await response.json();
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : "unknown error";
        errs.push(errMsg);
        if (++tries <= this.retries) await this.sleep(Math.pow(1.5, tries) * 1000); // simple backoff
      }
    } while (tries <= this.retries);

    throw new Error(`${this.name} price lookup failure (${errs.join(", ")})`);
  }

  protected sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
  }
}
