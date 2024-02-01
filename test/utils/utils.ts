import * as utils from "@across-protocol/contracts-v2/dist/test-utils";
import { BigNumber, BigNumberish, Contract, providers } from "ethers";
import {
  AcrossConfigStoreClient as ConfigStoreClient,
  GLOBAL_CONFIG_STORE_KEYS,
  HubPoolClient,
} from "../../src/clients";
import {
  SlowFillRequestWithBlock,
  V3RelayData,
  V2Deposit,
  V2Fill,
  V3Deposit,
  V3DepositWithBlock,
  V3FillWithBlock,
} from "../../src/interfaces";
import {
  bnUint32Max,
  bnZero,
  getCurrentTime,
  getDepositInputToken,
  getDepositInputAmount,
  resolveContractFromSymbol,
  toBN,
  toBNWei,
  toWei,
  utf8ToHex,
} from "../../src/utils";
import {
  amountToDeposit,
  depositRelayerFeePct,
  destinationChainId as defaultDestinationChainId,
  MAX_L1_TOKENS_PER_POOL_REBALANCE_LEAF,
  MAX_REFUNDS_PER_RELAYER_REFUND_LEAF,
  sampleRateModel,
} from "../constants";
import { AcrossConfigStore } from "@across-protocol/contracts-v2";
import chai, { expect } from "chai";
import chaiExclude from "chai-exclude";
import _ from "lodash";
import sinon from "sinon";
import winston, { LogEntry } from "winston";
import { SpokePoolDeploymentResult, SpyLoggerResult } from "../types";
import { EMPTY_MESSAGE, PROTOCOL_DEFAULT_CHAIN_ID_INDICES } from "../../src/constants";
import { SpyTransport } from "./SpyTransport";

chai.use(chaiExclude);
const assert = chai.assert;

export type SignerWithAddress = utils.SignerWithAddress;

export const {
  buildPoolRebalanceLeafTree,
  buildPoolRebalanceLeaves,
  deploySpokePool,
  depositV2,
  enableRoutes,
  getContractFactory,
  getDepositParams,
  getUpdatedV3DepositSignature,
  hubPoolFixture,
  modifyRelayHelper,
  randomAddress,
  zeroAddress,
} = utils;

export { assert, BigNumber, expect, chai, Contract, sinon, toBN, toBNWei, toWei, utf8ToHex, winston };

const TokenRolesEnum = {
  OWNER: "0",
  MINTER: "1",
  BURNER: "3",
};

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

export async function setupTokensForWallet(
  contractToApprove: utils.Contract,
  wallet: utils.SignerWithAddress,
  tokens: utils.Contract[],
  weth?: utils.Contract,
  seedMultiplier = 1
): Promise<void> {
  const approveToken = async (token: Contract) => {
    const balance = await token.balanceOf(wallet.address);
    await token.connect(wallet).approve(contractToApprove.address, balance);
  };

  await utils.seedWallet(wallet, tokens, weth, utils.amountToSeedWallets.mul(seedMultiplier));
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

export async function deploySpokePoolWithToken(
  fromChainId = 0,
  toChainId = 0,
  enableRoute = true
): Promise<SpokePoolDeploymentResult> {
  const { weth, erc20, spokePool, unwhitelistedErc20, destErc20 } = await utils.deploySpokePool(utils.ethers);
  const receipt = await spokePool.deployTransaction.wait();

  await spokePool.setChainId(fromChainId == 0 ? utils.originChainId : fromChainId);

  if (enableRoute) {
    await utils.enableRoutes(spokePool, [
      { originToken: erc20.address, destinationChainId: toChainId == 0 ? utils.destinationChainId : toChainId },
      { originToken: weth.address, destinationChainId: toChainId == 0 ? utils.destinationChainId : toChainId },
    ]);
  }
  return { weth, erc20, spokePool, unwhitelistedErc20, destErc20, deploymentBlock: receipt.blockNumber };
}

export async function deployConfigStore(
  signer: utils.SignerWithAddress,
  tokensToAdd: utils.Contract[],
  maxL1TokensPerPoolRebalanceLeaf: number = MAX_L1_TOKENS_PER_POOL_REBALANCE_LEAF,
  maxRefundPerRelayerRefundLeaf: number = MAX_REFUNDS_PER_RELAYER_REFUND_LEAF,
  rateModel: unknown = sampleRateModel,
  additionalChainIdIndices?: number[]
): Promise<{ configStore: AcrossConfigStore; deploymentBlock: number }> {
  const configStore = (await (
    await utils.getContractFactory("AcrossConfigStore", signer)
  ).deploy()) as AcrossConfigStore;
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
  signer: utils.SignerWithAddress,
  spokePools: { l2ChainId: number; spokePool: utils.Contract }[],
  finderAddress: string = zeroAddress,
  timerAddress: string = zeroAddress
): Promise<{
  hubPool: utils.Contract;
  mockAdapter: utils.Contract;
  l1Token_1: utils.Contract;
  l1Token_2: utils.Contract;
  hubPoolDeploymentBlock: number;
}> {
  const lpTokenFactory = await (await utils.getContractFactory("LpTokenFactory", signer)).deploy();
  const hubPool = await (
    await utils.getContractFactory("HubPool", signer)
  ).deploy(lpTokenFactory.address, finderAddress, zeroAddress, timerAddress);
  const receipt = await hubPool.deployTransaction.wait();

  const mockAdapter = await (await utils.getContractFactory("Mock_Adapter", signer)).deploy();

  for (const spokePool of spokePools) {
    await hubPool.setCrossChainContracts(spokePool.l2ChainId, mockAdapter.address, spokePool.spokePool.address);
  }

  const l1Token_1 = await (await utils.getContractFactory("ExpandedERC20", signer)).deploy("L1Token1", "L1Token1", 18);
  await l1Token_1.addMember(TokenRolesEnum.MINTER, signer.address);
  const l1Token_2 = await (await utils.getContractFactory("ExpandedERC20", signer)).deploy("L1Token2", "L1Token2", 18);
  await l1Token_2.addMember(TokenRolesEnum.MINTER, signer.address);

  return { hubPool, mockAdapter, l1Token_1, l1Token_2, hubPoolDeploymentBlock: receipt.blockNumber };
}

export async function enableRoutesOnHubPool(
  hubPool: utils.Contract,
  rebalanceRouteTokens: { destinationChainId: number; l1Token: utils.Contract; destinationToken: utils.Contract }[]
): Promise<void> {
  for (const tkn of rebalanceRouteTokens) {
    await hubPool.setPoolRebalanceRoute(tkn.destinationChainId, tkn.l1Token.address, tkn.destinationToken.address);
    await hubPool.enableL1TokenForLiquidityProvision(tkn.l1Token.address);
  }
}

export async function simpleDeposit(
  spokePool: utils.Contract,
  token: utils.Contract,
  recipient: utils.SignerWithAddress,
  depositor: utils.SignerWithAddress,
  destinationChainId = defaultDestinationChainId,
  amount = amountToDeposit,
  relayerFeePct = depositRelayerFeePct
): Promise<V2Deposit> {
  const depositObject = await utils.depositV2(
    spokePool,
    token,
    recipient,
    depositor,
    destinationChainId,
    amount,
    relayerFeePct
  );
  // Sanity Check: Ensure that the deposit was successful.
  expect(depositObject).to.not.be.null;
  if (!depositObject) {
    throw new Error("Deposit object is null");
  }
  return {
    ...depositObject,
    realizedLpFeePct: toBNWei("0"),
    destinationToken: zeroAddress,
    message: "0x",
  };
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
  signer: utils.SignerWithAddress,
  hubPool: utils.Contract,
  l1Token: utils.Contract,
  amount: utils.BigNumber
): Promise<void> {
  await utils.seedWallet(signer, [l1Token], undefined, amount);
  await l1Token.connect(signer).approve(hubPool.address, amount);
  await hubPool.enableL1TokenForLiquidityProvision(l1Token.address);
  await hubPool.connect(signer).addLiquidity(l1Token.address, amount);
}

// Submits a deposit transaction and returns the Deposit struct that that clients interact with.
export async function buildV2DepositStruct(
  deposit: Omit<V2Deposit, "destinationToken" | "realizedLpFeePct">,
  hubPoolClient: HubPoolClient
): Promise<V2Deposit & { quoteBlockNumber: number; blockNumber: number }> {
  const blockNumber = await hubPoolClient.getBlockNumber(deposit.quoteTimestamp);
  if (!blockNumber) {
    throw new Error("Timestamp is undefined");
  }

  const inputToken = getDepositInputToken(deposit);
  const inputAmount = getDepositInputAmount(deposit);
  const { quoteBlock, realizedLpFeePct } = await hubPoolClient.computeRealizedLpFeePct({
    ...deposit,
    inputToken,
    inputAmount,
    paymentChainId: deposit.destinationChainId,
    blockNumber,
  });
  return {
    ...deposit,
    destinationToken: hubPoolClient.getL2TokenForDeposit({
      ...deposit,
      quoteBlockNumber: quoteBlock,
    }),
    quoteBlockNumber: quoteBlock,
    realizedLpFeePct,
    blockNumber: await getLastBlockNumber(),
  };
}

export async function depositV3(
  spokePool: Contract,
  destinationChainId: number,
  signer: SignerWithAddress,
  inputToken: string,
  inputAmount: BigNumber,
  outputToken: string,
  outputAmount: BigNumber,
  opts: {
    destinationChainId?: number;
    recipient?: string;
    quoteTimestamp?: number;
    message?: string;
    fillDeadline?: number;
    exclusivityDeadline?: number;
    exclusiveRelayer?: string;
  } = {}
): Promise<V3DepositWithBlock> {
  const depositor = signer.address;
  const recipient = opts.recipient ?? depositor;

  const [spokePoolTime, fillDeadlineBuffer] = (
    await Promise.all([spokePool.getCurrentTime(), spokePool.fillDeadlineBuffer()])
  ).map((n) => Number(n));

  const quoteTimestamp = opts.quoteTimestamp ?? spokePoolTime;
  const message = opts.message ?? EMPTY_MESSAGE;
  const fillDeadline = opts.fillDeadline ?? spokePoolTime + fillDeadlineBuffer;
  const exclusivityDeadline = opts.exclusivityDeadline ?? 0;
  const exclusiveRelayer = opts.exclusiveRelayer ?? zeroAddress;

  await spokePool
    .connect(signer)
    .depositV3(
      depositor,
      recipient,
      inputToken,
      outputToken,
      inputAmount,
      outputAmount,
      destinationChainId,
      exclusiveRelayer,
      quoteTimestamp,
      fillDeadline,
      exclusivityDeadline,
      message
    );

  const [events, originChainId] = await Promise.all([
    spokePool.queryFilter(spokePool.filters.V3FundsDeposited()),
    spokePool.chainId(),
  ]);

  const lastEvent = events.at(-1);
  const args = lastEvent?.args;
  assert.exists(args);

  const { blockNumber, transactionHash, transactionIndex, logIndex } = lastEvent!;

  return {
    depositId: args!.depositId,
    originChainId: Number(originChainId),
    destinationChainId: Number(args!.destinationChainId),
    depositor: args!.depositor,
    recipient: args!.recipient,
    inputToken: args!.inputToken,
    inputAmount: args!.inputAmount,
    outputToken: args!.outputToken,
    outputAmount: args!.outputAmount,
    quoteTimestamp: args!.quoteTimestamp,
    message: args!.message,
    fillDeadline: args!.fillDeadline,
    exclusivityDeadline: args!.exclusivityDeadline,
    exclusiveRelayer: args!.exclusiveRelayer,
    quoteBlockNumber: 0, // @todo
    blockNumber,
    transactionHash,
    transactionIndex,
    logIndex,
  };
}

export async function requestV3SlowFill(
  spokePool: Contract,
  relayData: V3RelayData,
  signer: SignerWithAddress
): Promise<SlowFillRequestWithBlock> {
  const destinationChainId = Number(await spokePool.chainId());
  assert.notEqual(relayData.originChainId, destinationChainId);

  await spokePool.connect(signer).requestV3SlowFill(relayData);

  const events = await spokePool.queryFilter(spokePool.filters.RequestedV3SlowFill());
  const lastEvent = events.at(-1);
  let args = lastEvent!.args;
  assert.exists(args);
  args = args!;

  const { blockNumber, transactionHash, transactionIndex, logIndex } = lastEvent!;

  return {
    depositId: args.depositId,
    originChainId: Number(args.originChainId),
    destinationChainId,
    depositor: args.depositor,
    recipient: args.recipient,
    inputToken: args.inputToken,
    inputAmount: args.inputAmount,
    outputToken: args.outputToken,
    outputAmount: args.outputAmount,
    message: args.message,
    fillDeadline: args.fillDeadline,
    exclusivityDeadline: args.exclusivityDeadline,
    exclusiveRelayer: args.exclusiveRelayer,
    blockNumber,
    transactionHash,
    transactionIndex,
    logIndex,
  };
}

export async function fillV3Relay(
  spokePool: Contract,
  deposit: Omit<V3Deposit, "destinationChainId">,
  signer: SignerWithAddress,
  repaymentChainId?: number
): Promise<V3FillWithBlock> {
  const destinationChainId = Number(await spokePool.chainId());
  assert.notEqual(deposit.originChainId, destinationChainId);

  await spokePool.connect(signer).fillV3Relay(deposit, repaymentChainId ?? destinationChainId);

  const events = await spokePool.queryFilter(spokePool.filters.FilledV3Relay());
  const lastEvent = events.at(-1);
  let args = lastEvent!.args;
  assert.exists(args);
  args = args!;

  const { blockNumber, transactionHash, transactionIndex, logIndex } = lastEvent!;

  return {
    depositId: args.depositId,
    originChainId: Number(args.originChainId),
    destinationChainId,
    depositor: args.depositor,
    recipient: args.recipient,
    inputToken: args.inputToken,
    inputAmount: args.inputAmount,
    outputToken: args.outputToken,
    outputAmount: args.outputAmount,
    message: args.message,
    fillDeadline: args.fillDeadline,
    exclusivityDeadline: args.exclusivityDeadline,
    exclusiveRelayer: args.exclusiveRelayer,
    relayer: args.relayer,
    repaymentChainId: Number(args.repaymentChainId),
    relayExecutionInfo: {
      updatedRecipient: args.relayExecutionInfo.updatedRecipient,
      updatedMessage: args.relayExecutionInfo.updatedMessage,
      updatedOutputAmount: args.relayExecutionInfo.updatedOutputAmount,
      fillType: args.relayExecutionInfo.fillType,
    },
    blockNumber,
    transactionHash,
    transactionIndex,
    logIndex,
  };
}

// @note To be deprecated post-v3.
export async function buildDeposit(
  hubPoolClient: HubPoolClient,
  spokePool: Contract,
  tokenToDeposit: Contract,
  recipientAndDepositor: SignerWithAddress,
  destinationChainId: number,
  _amountToDeposit = amountToDeposit,
  relayerFeePct = depositRelayerFeePct
): Promise<V2Deposit> {
  const _deposit = await utils.depositV2(
    spokePool,
    tokenToDeposit,
    recipientAndDepositor,
    recipientAndDepositor,
    destinationChainId,
    _amountToDeposit,
    relayerFeePct
  );
  // Sanity Check: Ensure that the deposit was successful.
  expect(_deposit).to.not.be.null;
  const deposit: Omit<V2Deposit, "destinationToken" | "realizedLpFeePct"> = {
    depositId: Number(_deposit!.depositId),
    originChainId: Number(_deposit!.originChainId),
    destinationChainId: Number(_deposit!.destinationChainId),
    depositor: String(_deposit!.depositor),
    recipient: String(_deposit!.recipient),
    originToken: String(_deposit!.originToken),
    amount: toBN(_deposit!.amount),
    message: EMPTY_MESSAGE,
    relayerFeePct: toBN(_deposit!.relayerFeePct),
    quoteTimestamp: Number(_deposit!.quoteTimestamp),
  };

  return await buildV2DepositStruct(deposit, hubPoolClient);
}

// Submits a fillRelay transaction and returns the Fill struct that that clients will interact with.
export async function buildFill(
  spokePool: Contract,
  destinationToken: Contract,
  recipientAndDepositor: SignerWithAddress,
  relayer: SignerWithAddress,
  deposit: V2Deposit,
  pctOfDepositToFill: number,
  repaymentChainId?: number
): Promise<V2Fill> {
  // Sanity Check: ensure realizedLpFeePct is defined
  expect(deposit.realizedLpFeePct).to.not.be.undefined;
  if (!deposit.realizedLpFeePct) {
    throw new Error("realizedLpFeePct is undefined");
  }

  await spokePool.connect(relayer).fillRelay(
    ...utils.getFillRelayParams(
      utils.getRelayHash(
        recipientAndDepositor.address,
        recipientAndDepositor.address,
        deposit.depositId,
        deposit.originChainId,
        deposit.destinationChainId,
        destinationToken.address,
        deposit.amount,
        deposit.realizedLpFeePct,
        deposit.relayerFeePct
      ).relayData,
      deposit.amount
        .mul(toBNWei(1).sub(deposit.realizedLpFeePct.add(deposit.relayerFeePct)))
        .mul(toBNWei(pctOfDepositToFill))
        .div(toBNWei(1))
        .div(toBNWei(1)),
      repaymentChainId ?? deposit.destinationChainId
    )
  );
  const [events, destinationChainId] = await Promise.all([
    spokePool.queryFilter(spokePool.filters.FilledRelay()),
    spokePool.chainId(),
  ]);
  const lastEvent = events[events.length - 1];
  if (!lastEvent?.args) {
    throw new Error("No FilledRelay event emitted");
  }
  return {
    amount: lastEvent.args.amount,
    totalFilledAmount: lastEvent.args.totalFilledAmount,
    fillAmount: lastEvent.args.fillAmount,
    repaymentChainId: Number(lastEvent.args.repaymentChainId),
    originChainId: Number(lastEvent.args.originChainId),
    relayerFeePct: lastEvent.args.relayerFeePct,
    realizedLpFeePct: lastEvent.args.realizedLpFeePct,
    depositId: lastEvent.args.depositId,
    destinationToken: lastEvent.args.destinationToken,
    relayer: lastEvent.args.relayer,
    depositor: lastEvent.args.depositor,
    recipient: lastEvent.args.recipient,
    message: lastEvent.args.message,
    updatableRelayData: {
      recipient: lastEvent.args.updatableRelayData[0],
      message: lastEvent.args.updatableRelayData[1],
      relayerFeePct: toBN(lastEvent.args.updatableRelayData[2]),
      isSlowRelay: lastEvent.args.updatableRelayData[3],
      payoutAdjustmentPct: toBN(lastEvent.args.updatableRelayData[4]),
    },
    destinationChainId: Number(destinationChainId),
  };
}

export async function buildModifiedFill(
  spokePool: Contract,
  depositor: SignerWithAddress,
  relayer: SignerWithAddress,
  fillToBuildFrom: V2Fill,
  multipleOfOriginalRelayerFeePct: number,
  pctOfDepositToFill: number,
  newRecipient?: string,
  newMessage?: string
): Promise<V2Fill | null> {
  const relayDataFromFill = {
    depositor: fillToBuildFrom.depositor,
    recipient: fillToBuildFrom.recipient,
    destinationToken: fillToBuildFrom.destinationToken,
    amount: fillToBuildFrom.amount,
    originChainId: fillToBuildFrom.originChainId.toString(),
    destinationChainId: fillToBuildFrom.destinationChainId.toString(),
    realizedLpFeePct: fillToBuildFrom.realizedLpFeePct,
    relayerFeePct: fillToBuildFrom.relayerFeePct,
    depositId: fillToBuildFrom.depositId.toString(),
    message: fillToBuildFrom.message,
  };

  const { signature } = await utils.modifyRelayHelper(
    fillToBuildFrom.relayerFeePct.mul(multipleOfOriginalRelayerFeePct),
    fillToBuildFrom.depositId.toString(),
    fillToBuildFrom.originChainId.toString(),
    depositor,
    newRecipient ?? relayDataFromFill.recipient,
    newMessage ?? relayDataFromFill.message
  );
  const updatedRelayerFeePct = fillToBuildFrom.relayerFeePct.mul(multipleOfOriginalRelayerFeePct);
  await spokePool.connect(relayer).fillRelayWithUpdatedDeposit(
    ...utils.getFillRelayUpdatedFeeParams(
      relayDataFromFill,
      fillToBuildFrom.amount
        .mul(toBNWei(1).sub(fillToBuildFrom.realizedLpFeePct.add(updatedRelayerFeePct)))
        .mul(toBNWei(pctOfDepositToFill))
        .div(toBNWei(1))
        .div(toBNWei(1)),
      updatedRelayerFeePct,
      signature,
      Number(relayDataFromFill.destinationChainId),
      newRecipient ?? relayDataFromFill.recipient,
      newMessage ?? relayDataFromFill.message
    )
  );
  const [events, destinationChainId] = await Promise.all([
    spokePool.queryFilter(spokePool.filters.FilledRelay()),
    spokePool.chainId(),
  ]);
  const lastEvent = events[events.length - 1];
  if (lastEvent.args) {
    return {
      amount: lastEvent.args.amount,
      totalFilledAmount: lastEvent.args.totalFilledAmount,
      fillAmount: lastEvent.args.fillAmount,
      repaymentChainId: Number(lastEvent.args.repaymentChainId),
      originChainId: Number(lastEvent.args.originChainId),
      relayerFeePct: lastEvent.args.relayerFeePct,
      realizedLpFeePct: lastEvent.args.realizedLpFeePct,
      depositId: lastEvent.args.depositId,
      destinationToken: lastEvent.args.destinationToken,
      relayer: lastEvent.args.relayer,
      message: lastEvent.args.message,
      depositor: lastEvent.args.depositor,
      recipient: lastEvent.args.recipient,
      updatableRelayData: lastEvent.args.updatableRelayData,
      destinationChainId: Number(destinationChainId),
    };
  } else {
    return null;
  }
}

/**
 * Grabs the latest block number from the hardhat provider.
 * @returns The latest block number.
 */
export function getLastBlockNumber(): Promise<number> {
  return (utils.ethers.provider as unknown as providers.Provider).getBlockNumber();
}

export function convertMockedConfigClient(client: unknown): client is ConfigStoreClient {
  return true;
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

export function buildDepositForRelayerFeeTest(
  amount: BigNumberish,
  tokenSymbol: string,
  originChainId: string | number,
  toChainId: string | number
): V2Deposit {
  const originToken = resolveContractFromSymbol(tokenSymbol, String(originChainId));
  const destinationToken = resolveContractFromSymbol(tokenSymbol, String(toChainId));
  expect(originToken).to.not.be.undefined;
  expect(destinationToken).to.not.undefined;
  if (!originToken || !destinationToken) {
    throw new Error("Token not found");
  }
  return {
    amount: toBN(amount),
    depositId: bnUint32Max.toNumber(),
    depositor: randomAddress(),
    recipient: randomAddress(),
    relayerFeePct: bnZero,
    message: EMPTY_MESSAGE,
    originChainId: 1,
    destinationChainId: 10,
    quoteTimestamp: getCurrentTime(),
    originToken,
    destinationToken,
    realizedLpFeePct: bnZero,
  };
}
