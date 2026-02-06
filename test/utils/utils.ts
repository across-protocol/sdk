import { AcrossConfigStore } from "@across-protocol/contracts";
import assert from "assert";
import chai, { expect } from "chai";
import chaiExclude from "chai-exclude";
import { ethers, BaseContract, Contract, providers, Signer } from "ethers";
import { ethers as hreEthers } from "hardhat";
import { FakeContract, smock } from "@defi-wonderland/smock";
import _ from "lodash";
import sinon from "sinon";
import winston from "winston";
import type { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers";
import { AcrossConfigStoreClient as ConfigStoreClient, GLOBAL_CONFIG_STORE_KEYS } from "../../src/clients";
import { EMPTY_MESSAGE, PROTOCOL_DEFAULT_CHAIN_ID_INDICES, ZERO_ADDRESS } from "../../src/constants";
import { Deposit, DepositWithBlock, FillWithBlock, RelayData, SlowFillRequestWithBlock } from "../../src/interfaces";
import {
  Address,
  BigNumber,
  BigNumberish,
  bnOne,
  bnUint32Max,
  getCurrentTime,
  getMessageHash,
  isDefined,
  resolveContractFromSymbol,
  toAddressType,
  toBN,
  toBNWei,
  toBytes32,
  toEvmAddress,
  toWei,
  utf8ToHex,
} from "../../src/utils";
import {
  amountToSeedWallets,
  MAX_L1_TOKENS_PER_POOL_REBALANCE_LEAF,
  MAX_REFUNDS_PER_RELAYER_REFUND_LEAF,
  originChainId,
  randomAddress,
  sampleRateModel,
  TokenRolesEnum,
  zeroAddress,
} from "../constants";
import { SpokePoolDeploymentResult, SpyLoggerResult } from "../types";
import { SpyTransport } from "./SpyTransport";

chai.use(chaiExclude);
const chaiAssert = chai.assert;

export { ethers };
export type { SignerWithAddress };

// Re-export from fixtures
export {
  getDepositParams,
  getUpdatedV3DepositSignature,
  modifyRelayHelper,
  getRelayHash,
  getV3RelayHash,
  getLegacyV3RelayHash,
  getFillRelayParams,
  getFillRelayUpdatedFeeParams,
  getExecuteSlowRelayParams,
  deployMockSpokePoolCaller,
} from "../fixtures/SpokePool.Fixture";
export type {
  ContractRelayData,
  V3RelayData,
  V3RelayExecutionParams,
  SlowFill,
  V3SlowFill,
  UpdatedRelayerFeeData,
} from "../fixtures/SpokePool.Fixture";
export { FillType, FillStatus } from "../fixtures/SpokePool.Fixture";

// Re-export constants
export { randomAddress, zeroAddress };

// Import local Merkle utilities that use our local getContractFactory
export {
  buildPoolRebalanceLeafTree,
  buildPoolRebalanceLeaves,
  buildRelayerRefundTree,
  buildRelayerRefundLeaves,
  buildSlowRelayTree,
  buildV3SlowRelayTree,
  getParamType,
  constructSingleRelayerRefundTree,
  constructSingleChainTree,
} from "./MerkleLib.utils";

// Import and export the local getContractFactory
import { getContractFactory } from "./getContractFactory";
export { getContractFactory };

// Import local fixtures that use our local getContractFactory
import { hubPoolFixture, deployHubPool } from "../fixtures/HubPool.Fixture";
import { spokePoolFixture, deploySpokePool } from "../fixtures/SpokePool.Fixture";
export { hubPoolFixture, deployHubPool, spokePoolFixture, deploySpokePool };

// Import and export the merkle lib fixture
export { merkleLibFixture } from "../fixtures/MerkleLib.Fixture";

export { BigNumber, Contract, chai, chaiAssert, expect, sinon, toBN, toBNWei, toWei, utf8ToHex, winston };

// Re-export ethers utilities
const { defaultAbiCoder, keccak256 } = ethers.utils;
export { defaultAbiCoder, keccak256, Signer, FakeContract };

// ---------------------------------------------------------------------------
// Conversion / encoding helpers (mirroring contracts test-utils)
// ---------------------------------------------------------------------------

export const toWeiWithDecimals = (num: string | number | BigNumber, decimals: number): BigNumber =>
  ethers.utils.parseUnits(num.toString(), decimals);

export const toBNWeiWithDecimals = (num: string | number | BigNumber, decimals: number): BigNumber =>
  BigNumber.from(toWeiWithDecimals(num, decimals));

export const fromWei = (num: string | number | BigNumber): string => ethers.utils.formatUnits(num.toString());

export const hexToUtf8 = (input: string): string => ethers.utils.toUtf8String(input);

export const hexZeroPad = (input: string, length: number): string => ethers.utils.hexZeroPad(input, length);

export const addressToBytes = (input: string): string => hexZeroPad(input.toLowerCase(), 32);

export const bytes32ToAddress = (input: string): string => {
  if (!/^0x[a-fA-F0-9]{64}$/.test(input)) {
    throw new Error("Invalid bytes32 input");
  }
  return ethers.utils.getAddress("0x" + input.slice(26));
};

export const isBytes32 = (input: string): boolean => /^0x[0-9a-fA-F]{64}$/.test(input);

// ---------------------------------------------------------------------------
// Random data generators
// ---------------------------------------------------------------------------

export function randomBigNumber(bytes = 32, signed = false): BigNumber {
  const sign = signed && Math.random() < 0.5 ? "-" : "";
  const byteString = "0x" + Buffer.from(ethers.utils.randomBytes(signed ? bytes - 1 : bytes)).toString("hex");
  return ethers.BigNumber.from(sign + byteString);
}

export function randomBytes32(): string {
  return ethers.utils.hexlify(ethers.utils.randomBytes(32));
}

// ---------------------------------------------------------------------------
// Wallet / contract seeding
// ---------------------------------------------------------------------------

export async function seedWallet(
  walletToFund: Signer,
  tokens: Contract[],
  weth: Contract | undefined,
  amountToSeedWith: number | BigNumber
) {
  for (const token of tokens) await token.mint(await walletToFund.getAddress(), amountToSeedWith);

  if (weth) await weth.connect(walletToFund).deposit({ value: amountToSeedWith });
}

export async function seedContract(
  contract: Contract,
  walletToFund: Signer,
  tokens: Contract[],
  weth: Contract | undefined,
  amountToSeedWith: number | BigNumber
): Promise<void> {
  await seedWallet(walletToFund, tokens, weth, amountToSeedWith);
  for (const token of tokens) await token.connect(walletToFund).transfer(contract.address, amountToSeedWith);
  if (weth) await weth.connect(walletToFund).transfer(contract.address, amountToSeedWith);
}

// ---------------------------------------------------------------------------
// Smock fakes
// ---------------------------------------------------------------------------

export async function createFake(contractName: string, targetAddress = ""): Promise<FakeContract<BaseContract>> {
  const contractFactory = await getContractFactory(
    contractName,
    new ethers.VoidSigner(ethers.constants.AddressZero)
  );
  return smock.fake(contractFactory.interface.fragments, {
    address: targetAddress === "" ? undefined : targetAddress,
    provider: contractFactory.signer.provider,
  });
}

export async function createFakeFromABI(abi: unknown[], targetAddress = ""): Promise<FakeContract<BaseContract>> {
  return createTypedFakeFromABI<BaseContract>(abi, targetAddress);
}

export async function createTypedFakeFromABI<T extends BaseContract>(
  abi: unknown[],
  targetAddress = ""
): Promise<FakeContract<T>> {
  const signer = new ethers.VoidSigner(ethers.constants.AddressZero);
  return smock.fake<T>(abi as never[], {
    address: !targetAddress ? undefined : targetAddress,
    provider: signer.provider,
  });
}

// ---------------------------------------------------------------------------
// Solana / message helpers
// ---------------------------------------------------------------------------

export function trimSolanaAddress(bytes32Address: string): string {
  if (!ethers.utils.isHexString(bytes32Address, 32)) {
    throw new Error("Invalid bytes32 address");
  }
  const uint160Address = ethers.BigNumber.from(bytes32Address).mask(160);
  return ethers.utils.hexZeroPad(ethers.utils.hexlify(uint160Address), 20);
}

export function hashNonEmptyMessage(message: string): string {
  if (!ethers.utils.isHexString(message) || message.length % 2 !== 0) throw new Error("Invalid hex message bytes");
  // account for 0x prefix when checking length
  if (message.length > 2) {
    return ethers.utils.keccak256(message);
  }
  return ethers.utils.hexlify(new Uint8Array(32));
}

// ---------------------------------------------------------------------------
// createRandomBytes32 (kept for backward compatibility)
// ---------------------------------------------------------------------------

export const createRandomBytes32 = () => ethers.utils.hexlify(ethers.utils.randomBytes(32));

// ---------------------------------------------------------------------------
// Test helper functions
// ---------------------------------------------------------------------------

export function deepEqualsWithBigNumber(x: unknown, y: unknown, omitKeys: string[] = []): boolean {
  if (x === undefined || y === undefined || x === null || y === null) {
    return false;
  }
  const xObj = x as Record<string, unknown>;
  const yObj = y as Record<string, unknown>;
  const sortedKeysX = Object.fromEntries(
    Object.keys(xObj)
      .sort()
      .map((key) => [key, xObj[key]])
  );
  const sortedKeysY = Object.fromEntries(
    Object.keys(yObj)
      .sort()
      .map((key) => [key, yObj[key]])
  );
  chaiAssert.deepStrictEqual(_.omit(sortedKeysX, omitKeys), _.omit(sortedKeysY, omitKeys));
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
      chaiAssert.isTrue(err.message.includes(errMessage));
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

export async function setupTokensForWallet(
  contractToApprove: Contract,
  wallet: SignerWithAddress,
  tokens: Contract[],
  weth?: Contract,
  seedMultiplier = 1
): Promise<void> {
  const approveToken = async (token: Contract) => {
    const balance = await token.balanceOf(wallet.address);
    await token.connect(wallet).approve(contractToApprove.address, balance);
  };

  await seedWallet(wallet, tokens, weth, amountToSeedWallets.mul(seedMultiplier));
  await Promise.all(tokens.map(approveToken));

  if (weth) {
    await approveToken(weth);
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

export async function deploySpokePoolWithToken(fromChainId = 0): Promise<SpokePoolDeploymentResult> {
  const { weth, erc20, spokePool, unwhitelistedErc20, destErc20 } = await deploySpokePool(hreEthers);
  const receipt = await spokePool.deployTransaction.wait();

  await spokePool.setChainId(fromChainId == 0 ? originChainId : fromChainId);

  return { weth, erc20, spokePool, unwhitelistedErc20, destErc20, deploymentBlock: receipt.blockNumber };
}

export async function deployConfigStore(
  signer: SignerWithAddress,
  tokensToAdd: Contract[],
  maxL1TokensPerPoolRebalanceLeaf: number = MAX_L1_TOKENS_PER_POOL_REBALANCE_LEAF,
  maxRefundPerRelayerRefundLeaf: number = MAX_REFUNDS_PER_RELAYER_REFUND_LEAF,
  rateModel: unknown = sampleRateModel,
  additionalChainIdIndices?: number[]
): Promise<{ configStore: AcrossConfigStore; deploymentBlock: number }> {
  const configStore = (await (await getContractFactory("AcrossConfigStore", signer)).deploy()) as AcrossConfigStore;
  const { blockNumber: deploymentBlock } = await configStore.deployTransaction.wait();

  for (const token of tokensToAdd) {
    await configStore.updateTokenConfig(
      token.address,
      JSON.stringify({
        rateModel: rateModel,
      })
    );
  }
  await configStore.updateGlobalConfig(
    utf8ToHex(GLOBAL_CONFIG_STORE_KEYS.MAX_POOL_REBALANCE_LEAF_SIZE),
    maxL1TokensPerPoolRebalanceLeaf.toString()
  );
  await configStore.updateGlobalConfig(
    utf8ToHex(GLOBAL_CONFIG_STORE_KEYS.MAX_RELAYER_REPAYMENT_LEAF_SIZE),
    maxRefundPerRelayerRefundLeaf.toString()
  );

  if (additionalChainIdIndices) {
    await configStore.updateGlobalConfig(
      utf8ToHex(GLOBAL_CONFIG_STORE_KEYS.CHAIN_ID_INDICES),
      JSON.stringify([...PROTOCOL_DEFAULT_CHAIN_ID_INDICES, ...additionalChainIdIndices])
    );
  }
  return { configStore, deploymentBlock };
}

export async function deployAndConfigureHubPool(
  signer: SignerWithAddress,
  spokePools: { l2ChainId: number; spokePool: Contract }[],
  finderAddress: string = zeroAddress,
  timerAddress: string = zeroAddress
): Promise<{
  hubPool: Contract;
  mockAdapter: Contract;
  l1Token_1: Contract;
  l1Token_2: Contract;
  hubPoolDeploymentBlock: number;
}> {
  const lpTokenFactory = await (await getContractFactory("LpTokenFactory", signer)).deploy();
  const hubPool = await (
    await getContractFactory("HubPool", signer)
  ).deploy(lpTokenFactory.address, finderAddress, zeroAddress, timerAddress);
  const receipt = await hubPool.deployTransaction.wait();

  const mockAdapter = await (await getContractFactory("Mock_Adapter", signer)).deploy();

  for (const spokePool of spokePools) {
    await hubPool.setCrossChainContracts(spokePool.l2ChainId, mockAdapter.address, spokePool.spokePool.address);
  }

  const l1Token_1 = await (await getContractFactory("ExpandedERC20", signer)).deploy("L1Token1", "L1Token1", 18);
  await l1Token_1.addMember(TokenRolesEnum.MINTER, signer.address);
  const l1Token_2 = await (await getContractFactory("ExpandedERC20", signer)).deploy("L1Token2", "L1Token2", 18);
  await l1Token_2.addMember(TokenRolesEnum.MINTER, signer.address);

  return { hubPool, mockAdapter, l1Token_1, l1Token_2, hubPoolDeploymentBlock: receipt.blockNumber };
}

export async function enableRoutesOnHubPool(
  hubPool: Contract,
  rebalanceRouteTokens: { destinationChainId: number; l1Token: Contract; destinationToken: Contract }[]
): Promise<void> {
  for (const tkn of rebalanceRouteTokens) {
    await hubPool.setPoolRebalanceRoute(tkn.destinationChainId, tkn.l1Token.address, tkn.destinationToken.address);
    await hubPool.enableL1TokenForLiquidityProvision(tkn.l1Token.address);
  }
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

export async function addLiquidity(
  signer: SignerWithAddress,
  hubPool: Contract,
  l1Token: Contract,
  amount: BigNumber
): Promise<void> {
  await seedWallet(signer, [l1Token], undefined, amount);
  await l1Token.connect(signer).approve(hubPool.address, amount);
  await hubPool.enableL1TokenForLiquidityProvision(l1Token.address);
  await hubPool.connect(signer).addLiquidity(l1Token.address, amount);
}

export function deposit(
  spokePool: Contract,
  destinationChainId: number,
  signer: SignerWithAddress,
  inputToken: Address,
  inputAmount: BigNumber,
  outputToken: Address,
  outputAmount: BigNumber,
  opts: {
    destinationChainId?: number;
    recipient?: Address;
    quoteTimestamp?: number;
    message?: string;
    fillDeadline?: number;
    exclusivityDeadline?: number;
    exclusiveRelayer?: Address;
  } = {}
): Promise<DepositWithBlock> {
  return _deposit(spokePool, destinationChainId, signer, inputToken, inputAmount, outputToken, outputAmount, {
    ...opts,
    addressModifier: toBytes32,
  });
}

export function depositV3(
  spokePool: Contract,
  destinationChainId: number,
  signer: SignerWithAddress,
  inputToken: Address,
  inputAmount: BigNumber,
  outputToken: Address,
  outputAmount: BigNumber,
  opts: {
    destinationChainId?: number;
    recipient?: Address;
    quoteTimestamp?: number;
    message?: string;
    fillDeadline?: number;
    exclusivityDeadline?: number;
    exclusiveRelayer?: Address;
  } = {}
): Promise<DepositWithBlock> {
  return _deposit(spokePool, destinationChainId, signer, inputToken, inputAmount, outputToken, outputAmount, {
    ...opts,
    addressModifier: toEvmAddress,
  });
}

async function _deposit(
  spokePool: Contract,
  destinationChainId: number,
  signer: SignerWithAddress,
  inputToken: Address,
  inputAmount: BigNumber,
  outputToken: Address,
  outputAmount: BigNumber,
  opts: {
    destinationChainId?: number;
    recipient?: Address;
    quoteTimestamp?: number;
    message?: string;
    fillDeadline?: number;
    exclusivityDeadline?: number;
    exclusiveRelayer?: Address;
    addressModifier?: (address: string) => string;
  } = {}
): Promise<DepositWithBlock> {
  const depositor = toAddressType(signer.address, await spokePool.chainId());
  const recipient = opts.recipient ?? depositor;

  const [spokePoolTime, fillDeadlineBuffer] = (
    await Promise.all([spokePool.getCurrentTime(), spokePool.fillDeadlineBuffer()])
  ).map((n) => Number(n));

  const quoteTimestamp = opts.quoteTimestamp ?? spokePoolTime;
  const message = opts.message ?? EMPTY_MESSAGE;
  const fillDeadline = opts.fillDeadline ?? spokePoolTime + fillDeadlineBuffer;
  const exclusivityDeadline = opts.exclusivityDeadline ?? 0;
  const exclusiveRelayer = opts.exclusiveRelayer ?? toAddressType(zeroAddress, destinationChainId);

  await spokePool
    .connect(signer)
    .deposit(
      depositor.toBytes32(),
      recipient.toBytes32(),
      inputToken.toBytes32(),
      outputToken.toBytes32(),
      inputAmount,
      outputAmount,
      destinationChainId,
      exclusiveRelayer.toBytes32(),
      quoteTimestamp,
      fillDeadline,
      exclusivityDeadline,
      message
    );
  const getChainId = async (): Promise<number> => Promise.resolve(Number(await spokePool.chainId()));
  const [events, fetchedOriginChainId] = await Promise.all([
    spokePool.queryFilter(spokePool.filters.FundsDeposited()),
    getChainId(),
  ]);

  const lastEvent = events.at(-1);
  let args = lastEvent?.args;
  chaiAssert.exists(args);
  args = args!;

  const { blockNumber, transactionHash, transactionIndex, logIndex } = lastEvent!;
  assert(args.destinationChainId.toNumber() === destinationChainId);

  return {
    depositId: toBN(args.depositId),
    originChainId: fetchedOriginChainId,
    destinationChainId,
    depositor: toAddressType(args.depositor, fetchedOriginChainId),
    recipient: toAddressType(args.recipient, destinationChainId),
    inputToken: toAddressType(args.inputToken, fetchedOriginChainId),
    inputAmount: args.inputAmount,
    outputToken: toAddressType(args.outputToken, destinationChainId),
    outputAmount: args.outputAmount,
    quoteTimestamp: args.quoteTimestamp,
    message: args.message,
    messageHash: getMessageHash(args.message),
    fillDeadline: args.fillDeadline,
    exclusivityDeadline: args.exclusivityDeadline,
    exclusiveRelayer: toAddressType(args.exclusiveRelayer, destinationChainId),
    fromLiteChain: false,
    toLiteChain: false,
    quoteBlockNumber: 0, // @todo
    blockNumber,
    txnRef: transactionHash,
    txnIndex: transactionIndex,
    logIndex,
  };
}

export async function requestV3SlowFill(
  spokePool: Contract,
  relayData: RelayData,
  signer: SignerWithAddress
): Promise<SlowFillRequestWithBlock> {
  const destinationChainId = Number(await spokePool.chainId());
  chaiAssert.notEqual(relayData.originChainId, destinationChainId);

  await spokePool.connect(signer).requestSlowFill({
    ...relayData,
    depositor: relayData.depositor.toBytes32(),
    recipient: relayData.recipient.toBytes32(),
    inputToken: relayData.inputToken.toBytes32(),
    outputToken: relayData.outputToken.toBytes32(),
    exclusiveRelayer: relayData.exclusiveRelayer.toBytes32(),
  });

  const events = await spokePool.queryFilter(spokePool.filters.RequestedSlowFill());
  const lastEvent = events.at(-1);
  expect(lastEvent).to.exist;

  const { blockNumber, transactionHash, transactionIndex, logIndex } = lastEvent!;
  expect(lastEvent!.args).to.exist;
  const args = lastEvent!.args!;
  const fetchedOriginChainId = Number(args.originChainId);

  return {
    depositId: toBN(args.depositId),
    originChainId: fetchedOriginChainId,
    destinationChainId,
    depositor: toAddressType(args.depositor, fetchedOriginChainId),
    recipient: toAddressType(args.recipient, destinationChainId),
    inputToken: toAddressType(args.inputToken, fetchedOriginChainId),
    inputAmount: args.inputAmount,
    outputToken: toAddressType(args.outputToken, destinationChainId),
    outputAmount: args.outputAmount,
    messageHash: getMessageHash(args.message),
    fillDeadline: args.fillDeadline,
    exclusivityDeadline: args.exclusivityDeadline,
    exclusiveRelayer: toAddressType(args.exclusiveRelayer, destinationChainId),
    blockNumber,
    txnRef: transactionHash,
    txnIndex: transactionIndex,
    logIndex,
  };
}

export async function fillRelay(
  spokePool: Contract,
  _deposit: Omit<Deposit, "destinationChainId">,
  signer: SignerWithAddress,
  repayment?: {
    repaymentChainId: number;
    repaymentAddress: Address;
  }
): Promise<FillWithBlock> {
  const destinationChainId = Number(await spokePool.chainId());
  chaiAssert.notEqual(_deposit.originChainId, destinationChainId);

  const depositData = {
    ..._deposit,
    depositor: _deposit.depositor.toBytes32(),
    recipient: _deposit.recipient.toBytes32(),
    exclusiveRelayer: _deposit.exclusiveRelayer.toBytes32(),
    inputToken: _deposit.inputToken.toBytes32(),
    outputToken: _deposit.outputToken.toBytes32(),
  };

  const repaymentAddress = repayment?.repaymentAddress.toBytes32() ?? toBytes32(signer.address);

  await spokePool
    .connect(signer)
    .fillRelay(depositData, repayment?.repaymentChainId ?? destinationChainId, repaymentAddress);

  const events = await spokePool.queryFilter(spokePool.filters.FilledRelay());
  const lastEvent = events.at(-1);
  let args = lastEvent!.args;
  chaiAssert.exists(args);
  args = args!;

  const { blockNumber, transactionHash, transactionIndex, logIndex } = lastEvent!;

  return {
    depositId: toBN(args.depositId),
    originChainId: Number(args.originChainId),
    destinationChainId,
    depositor: toAddressType(args.depositor, args.originChainId),
    recipient: toAddressType(args.recipient, destinationChainId),
    inputToken: toAddressType(args.inputToken, args.originChainId),
    inputAmount: args.inputAmount,
    outputToken: toAddressType(args.outputToken, destinationChainId),
    outputAmount: args.outputAmount,
    messageHash: getMessageHash(args.message),
    fillDeadline: args.fillDeadline,
    exclusivityDeadline: args.exclusivityDeadline,
    exclusiveRelayer: toAddressType(args.exclusiveRelayer, destinationChainId),
    relayer: args.relayer,
    repaymentChainId: Number(args.repaymentChainId),
    relayExecutionInfo: {
      updatedRecipient: toAddressType(args.relayExecutionInfo.updatedRecipient, destinationChainId),
      updatedMessageHash: args.relayExecutionInfo.updatedMessageHash,
      updatedOutputAmount: args.relayExecutionInfo.updatedOutputAmount,
      fillType: args.relayExecutionInfo.fillType,
    },
    blockNumber,
    txnRef: transactionHash,
    txnIndex: transactionIndex,
    logIndex,
  };
}

/**
 * Grabs the latest block number from the hardhat provider.
 * @returns The latest block number.
 */
export function getLastBlockNumber(): Promise<number> {
  return (hreEthers.provider as unknown as providers.Provider).getBlockNumber();
}

export function convertMockedConfigClient(_client: unknown): _client is ConfigStoreClient {
  return true;
}

// Iterate over each element in the log and see if it is a big number. if it is, then try casting it to a string to
// make it more readable. If something goes wrong in parsing the object (it's too large or something else) then simply
// return the original log entry without modifying it.
export function bigNumberFormatter(logEntry: winston.Logform.TransformableInfo): winston.Logform.TransformableInfo {
  type SymbolRecord = Record<string | symbol, unknown>;
  try {
    // Out is the original object if and only if one or more BigNumbers were replaced.
    const out = iterativelyReplaceBigNumbers(logEntry as Record<string | symbol, unknown>);

    // Because winston depends on some non-enumerable symbol properties, we explicitly copy those over, as they are not
    // handled in iterativelyReplaceBigNumbers. This only needs to happen if logEntry is being replaced.
    if (out !== logEntry)
      Object.getOwnPropertySymbols(logEntry).map(
        (symbol) => ((out as SymbolRecord)[symbol] = (logEntry as unknown as SymbolRecord)[symbol])
      );
    return out as winston.Logform.TransformableInfo;
  } catch (_) {
    return logEntry;
  }
}

// Traverse a potentially nested object and replace any element that is either a Ethers BigNumber or web3 BigNumber
// with the string version of it for easy logging.
const iterativelyReplaceBigNumbers = (obj: Record<string, unknown>) => {
  // This does a DFS, recursively calling this function to find the desired value for each key.
  // It doesn't modify the original object. Instead, it creates an array of keys and updated values.
  const replacements = Object.entries(obj).map(([key, value]): [string, unknown] => {
    if (BigNumber.isBigNumber(value)) return [key, value.toString()];
    else if (typeof value === "object" && value !== null)
      return [key, iterativelyReplaceBigNumbers(value as Record<string, unknown>)];
    else return [key, value];
  });

  // This will catch any values that were changed by value _or_ by reference.
  // If no changes were detected, no copy is needed and it is fine to discard the copy and return the original object.
  const copyNeeded = replacements.some(([key, value]) => obj[key] !== value);

  // Only copy if something changed. Otherwise, return the original object.
  return copyNeeded ? Object.fromEntries(replacements) : obj;
};

export function buildDepositForRelayerFeeTest(
  amount: BigNumberish,
  tokenSymbol: string,
  originChainId: number,
  toChainId: number
): Deposit {
  const _inputToken = resolveContractFromSymbol(tokenSymbol, originChainId);
  assert(isDefined(_inputToken), `${tokenSymbol} not found on ${originChainId}`);
  const inputToken = toAddressType(_inputToken, originChainId);

  const _outputToken = resolveContractFromSymbol(tokenSymbol, toChainId);
  assert(isDefined(_outputToken), `${tokenSymbol} not found on ${toChainId}`);
  const outputToken = toAddressType(_outputToken, toChainId);

  const currentTime = getCurrentTime();
  const message = EMPTY_MESSAGE;
  return {
    depositId: bnUint32Max,
    originChainId: originChainId,
    destinationChainId: toChainId,
    depositor: toAddressType(randomAddress(), originChainId),
    recipient: toAddressType(randomAddress(), toChainId),
    inputToken,
    inputAmount: toBN(amount),
    outputToken,
    outputAmount: toBN(amount).sub(bnOne),
    message,
    messageHash: getMessageHash(message),
    quoteTimestamp: currentTime,
    fillDeadline: currentTime + 7200,
    exclusivityDeadline: 0,
    exclusiveRelayer: toAddressType(ZERO_ADDRESS, toChainId),
    fromLiteChain: false,
    toLiteChain: false,
  };
}
