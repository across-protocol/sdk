import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers";
import { providers, BigNumber, Contract, Signer } from "ethers";
import { constants } from "./index";
export { sinon, winston };
import chai from "chai";
import chaiExclude from "chai-exclude";
import _ from "lodash";
import sinon from "sinon";
import winston, { LogEntry } from "winston";
import { ethers } from "hardhat";
import { SpyLoggerResult } from "../types";
import { SpyTransport } from "./SpyTransport";

chai.use(chaiExclude);

const assert = chai.assert;
export { assert, chai };

export function deepEqualsWithBigNumber(x: unknown, y: unknown, omitKeys: string[] = []): boolean {
  if (x === undefined || y === undefined || x === null || y === null) {
    return false;
  }
  const sortedKeysX = Object.fromEntries(
    Object.keys(x)
      .sort()
      .map((key) => [key, x?.[key]])
  );
  const sortedKeysY = Object.fromEntries(
    Object.keys(y)
      .sort()
      .map((key) => [key, y?.[key]])
  );
  assert.deepStrictEqual(_.omit(sortedKeysX, omitKeys), _.omit(sortedKeysY, omitKeys));
  return true;
}

export async function assertPromiseError<T>(promise: Promise<T>, errMessage?: string): Promise<void> {
  const SPECIAL_ERROR_MESSAGE = "Promise didn't fail";
  try {
    await promise;
    throw new Error(SPECIAL_ERROR_MESSAGE);
  } catch (e: unknown) {
    const err: Error = e as Error;
    if (err.message.includes(SPECIAL_ERROR_MESSAGE)) {
      throw err;
    }
    if (errMessage) {
      assert.isTrue(err.message.includes(errMessage));
    }
  }
}
export async function assertPromisePasses<T>(promise: Promise<T>): Promise<void> {
  try {
    await promise;
  } catch (e: unknown) {
    const err: Error = e as Error;
    throw new Error("Promise failed: " + err.message);
  }
}

export async function seedWallet(
  walletToFund: Signer,
  tokens: Contract[],
  weth: Contract | undefined,
  amountToSeedWith: number | BigNumber
) {
  for (const token of tokens) await token.mint(await walletToFund.getAddress(), amountToSeedWith);

  if (weth) await weth.connect(walletToFund).deposit({ value: amountToSeedWith });
}

export async function setupTokensForWallet(
  contractToApprove: Contract,
  wallet: SignerWithAddress,
  tokens: Contract[],
  weth?: Contract,
  seedMultiplier = 1
): Promise<void> {
  await seedWallet(wallet, tokens, weth, constants.amountToSeedWallets.mul(seedMultiplier));
  await Promise.all(
    tokens.map((token) =>
      token.connect(wallet).approve(contractToApprove.address, constants.amountToDeposit.mul(seedMultiplier))
    )
  );
  if (weth) {
    await weth.connect(wallet).approve(contractToApprove.address, constants.amountToDeposit);
  }
}

export function createSpyLogger(): SpyLoggerResult {
  const spy = sinon.spy();
  const spyLogger = winston.createLogger({
    level: "debug",
    format: winston.format.combine(winston.format(bigNumberFormatter)(), winston.format.json()),
    transports: [
      new SpyTransport({ level: "debug" }, { spy }),
      process.env.LOG_IN_TEST ? new winston.transports.Console() : null,
    ].filter((n) => n) as winston.transport[],
  });

  return { spy, spyLogger };
}

export function randomAddress() {
  return ethers.utils.getAddress(ethers.utils.hexlify(ethers.utils.randomBytes(20)));
}

/**
 * Takes as input a body and returns a new object with the body and a message property. Used to appease the typescript
 * compiler when we want to return a type that doesn't have a message property.
 * @param body Typically a partial structure of a Deposit or Fill.
 * @returns A new object with the body and a message property.
 */
export function appendMessageToResult<T>(body: T): T & { message: string } {
  return { ...body, message: "" };
}

export async function getLastBlockTime(provider: providers.Provider): Promise<number> {
  return (await provider.getBlock(await provider.getBlockNumber())).timestamp;
}

/**
 * Grabs the latest block number from the hardhat provider.
 * @returns The latest block number.
 */
export function getLastBlockNumber(): Promise<number> {
  return (ethers.provider as unknown as providers.Provider).getBlockNumber();
}

// Iterate over each element in the log and see if it is a big number. if it is, then try casting it to a string to
// make it more readable. If something goes wrong in parsing the object (it's too large or something else) then simply
// return the original log entry without modifying it.
export function bigNumberFormatter(logEntry: LogEntry) {
  type SymbolRecord = Record<string | symbol, unknown>;
  try {
    // Out is the original object if and only if one or more BigNumbers were replaced.
    const out = iterativelyReplaceBigNumbers(logEntry);

    // Because winston depends on some non-enumerable symbol properties, we explicitly copy those over, as they are not
    // handled in iterativelyReplaceBigNumbers. This only needs to happen if logEntry is being replaced.
    if (out !== logEntry)
      Object.getOwnPropertySymbols(logEntry).map(
        (symbol) => (out[symbol] = (logEntry as unknown as SymbolRecord)[symbol])
      );
    return out as LogEntry;
  } catch (_) {
    return logEntry;
  }
}

// Traverse a potentially nested object and replace any element that is either a Ethers BigNumber or web3 BigNumber
// with the string version of it for easy logging.
const iterativelyReplaceBigNumbers = (obj: Record<string | symbol, unknown> | object) => {
  // This does a DFS, recursively calling this function to find the desired value for each key.
  // It doesn't modify the original object. Instead, it creates an array of keys and updated values.
  const replacements = Object.entries(obj).map(([key, value]): [string, unknown] => {
    if (BigNumber.isBigNumber(value)) return [key, value.toString()];
    else if (typeof value === "object" && value !== null) return [key, iterativelyReplaceBigNumbers(value)];
    else return [key, value];
  });

  // This will catch any values that were changed by value _or_ by reference.
  // If no changes were detected, no copy is needed and it is fine to discard the copy and return the original object.
  const copyNeeded = replacements.some(([key, value]) => obj[key] !== value);

  // Only copy if something changed. Otherwise, return the original object.
  return copyNeeded ? Object.fromEntries(replacements) : obj;
};
