import winston from "winston";
// import { Rpc, RpcTransport, SolanaRpcApiFromTransport, } from "@solana/kit";
import { CachedSolanaRpcFactory } from "../../providers";
export * from "./SpokeUtils";
import * as utils from "./SpokeUtils";
import { CHAIN_IDs } from "../../constants";

async function run(): Promise<number> {
  const logger = winston.createLogger({
    transports: [new winston.transports.Console()],
    level: "debug",
  });
  const cacheNamespace = "across";
  const redis = undefined;
  const maxConcurrency = 10;
  const url = "https://solana-mainnet.g.alchemy.com/v2/TqEFuc6mBICfXwjc0THSmWe5NTwsfaNu";
  const chainId = CHAIN_IDs.SOLANA;
  const provider = new CachedSolanaRpcFactory(
    cacheNamespace,
    redis,
    maxConcurrency,
    1,
    logger,
    url,
    chainId
  ).createRpcClient();

  const blockHeight = 309_068_101;
  const timestamp = await utils.getTimestampForBlock(provider, blockHeight);
  console.log(`xxx got timestamp: ${timestamp}.`);
  return 0;
}

if (require.main === module) {
  run()
    .then((result: number) => {
      process.exitCode = result;
    })
    .catch((error) => {
      console.error("Process exited with", error);
      process.exitCode = 127;
    });
}
