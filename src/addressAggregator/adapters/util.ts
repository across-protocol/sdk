import axios from "axios";
import { Logger } from "../../utils";

export { Logger } from "../../utils";

const { ACROSS_USER_AGENT = "across-protocol" } = process.env;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export function logError(name: string, error: unknown, logger?: Logger): Promise<string[]> {
  let reason: string;
  if (error instanceof Error) {
    reason = error.message;
  } else {
    reason = typeof error === "string" ? error : "unknown error";
  }

  logger?.warn({
    at: `${name}::update`,
    message: `Failed to read addresses from ${name}.`,
    reason,
  });
  return Promise.resolve([]);
}

export async function fetch(name: string, url: string, timeout = 2000, retries = 1): Promise<unknown> {
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
      if (++tries <= retries) await sleep(Math.pow(1.5, tries) * 1000); // simple backoff
    }
  } while (tries <= retries);

  throw new Error(`${name} retrieval failure (${errs.join(", ")})`);
}
