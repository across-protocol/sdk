import axios from "axios";

const { ACROSS_USER_AGENT = "across-protocol" } = process.env;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
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
