import { createServer, Server } from "http";
import winston from "winston";
import { RateLimitedProvider } from "../../src/providers";
import { expect } from "../utils";

// Serves a 429 for the first `throttleCount` requests, then a valid eth_chainId result.
function rpcServer(throttleCount: number): Promise<{ server: Server; url: string }> {
  let seen = 0;
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      if (seen++ < throttleCount) {
        res.writeHead(429, { "content-type": "application/json" });
        return res.end(JSON.stringify({ error: "rate limited" }));
      }
      const { id } = JSON.parse(body);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id, result: "0x1" }));
    });
  });
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as { port: number };
      resolve({ server, url: `http://127.0.0.1:${port}` });
    })
  );
}

describe("RateLimitedProvider concurrency feedback", () => {
  const logger = winston.createLogger({ transports: [new winston.transports.Console({ silent: true })] });

  it("starts at maxConcurrency", async () => {
    const { server, url } = await rpcServer(0);
    expect(new RateLimitedProvider(16, 0, logger, { url }, 1).concurrency).to.equal(16);
    server.close();
  });

  it("narrows the queue on a rate-limit response and widens once the backlog clears", async () => {
    // One 429, then success, so a single send exercises both halves of the loop.
    const { server, url } = await rpcServer(1);
    const provider = new RateLimitedProvider(16, 0, logger, { url, throttleLimit: 3 }, 1);

    const result = await provider.send("eth_chainId", []);

    expect(result).to.equal("0x1");
    // Halved to 8 by the 429, then +1 on the success that followed with an empty backlog.
    expect(provider.concurrency).to.equal(9);
    server.close();
  }).timeout(15000);

  it("never narrows below one in-flight request", async () => {
    const { server, url } = await rpcServer(0);
    const provider = new RateLimitedProvider(2, 0, logger, { url }, 1);
    const throttleCallback = provider.connection.throttleCallback;
    expect(throttleCallback).to.not.be.undefined;

    // 2 -> 1, then pinned: floor(1 / 2) would be 0.
    await throttleCallback?.(0, url);
    await throttleCallback?.(0, url);

    expect(provider.concurrency).to.equal(1);
    server.close();
  }).timeout(15000);
});
