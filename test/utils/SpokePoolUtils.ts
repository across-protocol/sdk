import { Contract } from "ethers";
import {
  DepositWithBlock,
  Fill,
  FillStatus,
  FillType,
  RelayData,
  V2Deposit,
  V2DepositWithBlock,
  V2Fill,
  V2RelayData,
  V3DepositWithBlock,
  V3Fill,
  V3RelayData,
} from "../../src/interfaces";
import {
  bnUint32Max,
  bnZero,
  getCurrentTime,
  getDepositInputAmount,
  getDepositInputToken,
  getNetworkName,
  getRelayDataHash,
  getRelayDataOutputAmount,
  isV2Deposit,
  isV2RelayData,
  resolveContractFromSymbol,
} from "../../src/utils";
import hre, { ethers } from "hardhat";
import { getContractFactory } from "@across-protocol/contracts-v2";
import {
  constants,
  SignerWithAddress,
  BigNumber,
  expect,
  toBNWei,
  randomAddress,
  toBN,
  ethersUtils,
  getLastBlockNumber,
  TokenRolesEnum,
} from "./index";
import { assert } from "chai";
import { SpokePoolDeploymentResult } from "../types";
import { EMPTY_MESSAGE } from "../../src/constants";
import { HubPoolClient } from "../../src/clients";

export function fillFromDeposit(deposit: DepositWithBlock, relayer: string): Fill {
  return isV2Deposit(deposit) ? v2FillFromDeposit(deposit, relayer) : v3FillFromDeposit(deposit, relayer);
}

export function v2FillFromDeposit(deposit: V2DepositWithBlock, relayer: string): V2Fill {
  const { recipient, message, relayerFeePct } = deposit;

  const fill: Fill = {
    amount: deposit.amount,
    depositId: deposit.depositId,
    originChainId: deposit.originChainId,
    destinationChainId: deposit.destinationChainId,
    depositor: deposit.depositor,
    destinationToken: deposit.destinationToken,
    relayerFeePct: deposit.relayerFeePct,
    realizedLpFeePct: deposit.realizedLpFeePct ?? bnZero,
    recipient,
    relayer,
    message,

    // Caller can modify these later.
    fillAmount: deposit.amount,
    totalFilledAmount: deposit.amount,
    repaymentChainId: deposit.destinationChainId,

    updatableRelayData: {
      recipient: deposit.updatedRecipient ?? recipient,
      message: deposit.updatedMessage ?? message,
      relayerFeePct: deposit.newRelayerFeePct ?? relayerFeePct,
      isSlowRelay: false,
      payoutAdjustmentPct: bnZero,
    },
  };

  return fill;
}

export function v3FillFromDeposit(deposit: V3DepositWithBlock, relayer: string): V3Fill {
  const { blockNumber, transactionHash, transactionIndex, ...partialDeposit } = deposit;
  const { recipient, message } = partialDeposit;

  const fill: V3Fill = {
    ...partialDeposit,
    relayer,

    // Caller can modify these later.
    exclusiveRelayer: relayer,
    repaymentChainId: deposit.destinationChainId,
    updatableRelayData: {
      recipient: deposit.updatedRecipient ?? recipient,
      message: deposit.updatedMessage ?? message,
      outputAmount: deposit.updatedOutputAmount ?? deposit.outputAmount,
      fillType: FillType.FastFill,
    },
  };

  return fill;
}

export async function deploySpokePool(): Promise<{
  weth: Contract;
  erc20: Contract;
  spokePool: Contract;
  unwhitelistedErc20: Contract;
  destErc20: Contract;
  erc1271: Contract;
}> {
  const [deployerWallet, crossChainAdmin, hubPool] = await ethers.getSigners();

  // Create tokens:
  const weth = await (await getContractFactory("WETH9", deployerWallet)).deploy();
  const erc20 = await (await getContractFactory("ExpandedERC20", deployerWallet)).deploy("USD Coin", "USDC", 18);
  await erc20.addMember(TokenRolesEnum.MINTER, deployerWallet.address);
  const unwhitelistedErc20 = await (
    await getContractFactory("ExpandedERC20", deployerWallet)
  ).deploy("Unwhitelisted", "UNWHITELISTED", 18);
  await unwhitelistedErc20.addMember(TokenRolesEnum.MINTER, deployerWallet.address);
  const destErc20 = await (
    await getContractFactory("ExpandedERC20", deployerWallet)
  ).deploy("L2 USD Coin", "L2 USDC", 18);
  await destErc20.addMember(TokenRolesEnum.MINTER, deployerWallet.address);

  // Deploy the pool
  const spokePool = await hre.upgrades.deployProxy(
    await getContractFactory("_MockSpokePool", deployerWallet),
    [0, crossChainAdmin.address, hubPool.address],
    { kind: "uups", unsafeAllow: ["delegatecall"], constructorArgs: [weth.address] }
  );
  await spokePool.setChainId(constants.destinationChainId);

  // ERC1271
  const erc1271 = await (await getContractFactory("MockERC1271", deployerWallet)).deploy(deployerWallet.address);

  return {
    weth,
    erc20,
    spokePool,
    unwhitelistedErc20,
    destErc20,
    erc1271,
  };
}

export interface DepositRoute {
  originToken: string;
  destinationChainId?: number;
  enabled?: boolean;
}
export async function enableRoutes(spokePool: Contract, routes: DepositRoute[]) {
  for (const route of routes) {
    await spokePool.setEnableRoute(
      route.originToken,
      route.destinationChainId ?? constants.destinationChainId,
      route.enabled ?? true
    );
  }
}
export async function deploySpokePoolWithToken(
  fromChainId = 0,
  toChainId = 0,
  enableRoute = true
): Promise<SpokePoolDeploymentResult> {
  const { weth, erc20, spokePool, unwhitelistedErc20, destErc20 } = await deploySpokePool();
  const receipt = await spokePool.deployTransaction.wait();

  await spokePool.setChainId(fromChainId == 0 ? constants.originChainId : fromChainId);

  if (enableRoute) {
    await enableRoutes(spokePool, [
      { originToken: erc20.address, destinationChainId: toChainId == 0 ? constants.destinationChainId : toChainId },
      { originToken: weth.address, destinationChainId: toChainId == 0 ? constants.destinationChainId : toChainId },
    ]);
  }
  return { weth, erc20, spokePool, unwhitelistedErc20, destErc20, deploymentBlock: receipt.blockNumber };
}

export type V2PartialDeposit = Omit<V2Deposit, "destinationToken" | "realizedLpFeePct">;

export function getDepositV2Params(args: {
  recipient?: string;
  originToken: string;
  amount: BigNumber;
  destinationChainId: number;
  relayerFeePct: BigNumber;
  quoteTimestamp: number;
  message?: string;
  maxCount?: BigNumber;
}): string[] {
  return [
    args.recipient ?? randomAddress(),
    args.originToken,
    args.amount.toString(),
    args.destinationChainId.toString(),
    args.relayerFeePct.toString(),
    args.quoteTimestamp.toString(),
    args.message ?? "0x",
    args?.maxCount?.toString() ?? constants.maxUint256.toString(),
  ];
}

export async function depositV2(
  spokePool: Contract,
  token: Contract,
  recipient: SignerWithAddress,
  depositor: SignerWithAddress,
  destinationChainId: number = constants.destinationChainId,
  amount = constants.amountToDeposit,
  relayerFeePct = constants.depositRelayerFeePct,
  quoteTimestamp?: number,
  message?: string
): Promise<V2PartialDeposit | null> {
  await spokePool.connect(depositor).depositV2(
    ...getDepositV2Params({
      recipient: recipient.address,
      originToken: token.address,
      amount,
      destinationChainId,
      relayerFeePct,
      quoteTimestamp: quoteTimestamp ?? (await spokePool.getCurrentTime()).toNumber(),
      message,
    })
  );
  const [events, originChainId] = await Promise.all([
    spokePool.queryFilter(spokePool.filters.FundsDeposited()),
    spokePool.chainId(),
  ]);

  const lastEvent = events[events.length - 1];
  return lastEvent.args === undefined
    ? null
    : {
        amount: lastEvent.args.amount,
        originChainId: Number(originChainId),
        destinationChainId: Number(lastEvent.args.destinationChainId),
        relayerFeePct: lastEvent.args.relayerFeePct,
        depositId: lastEvent.args.depositId,
        quoteTimestamp: lastEvent.args.quoteTimestamp,
        originToken: lastEvent.args.originToken,
        recipient: lastEvent.args.recipient,
        depositor: lastEvent.args.depositor,
        message: lastEvent.args.message,
      };
}

export async function simpleDeposit(
  spokePool: Contract,
  token: Contract,
  recipient: SignerWithAddress,
  depositor: SignerWithAddress,
  destinationChainId: number = constants.destinationChainId,
  amountToDeposit: BigNumber = constants.amountToDeposit,
  depositRelayerFeePct: BigNumber = constants.depositRelayerFeePct
): Promise<V2Deposit> {
  const depositObject = await depositV2(
    spokePool,
    token,
    recipient,
    depositor,
    destinationChainId,
    amountToDeposit,
    depositRelayerFeePct
  );
  // Sanity Check: Ensure that the deposit was successful.
  expect(depositObject).to.not.be.null;
  if (!depositObject) {
    throw new Error("Deposit object is null");
  }
  return {
    ...depositObject,
    realizedLpFeePct: toBNWei("0"),
    destinationToken: constants.zeroAddress,
    message: "0x",
  };
}

// Submits a deposit transaction and returns the Deposit struct that that clients interact with.
export async function buildV2DepositStruct(
  deposit: V2PartialDeposit,
  hubPoolClient: HubPoolClient
): Promise<V2DepositWithBlock & { quoteBlockNumber: number; blockNumber: number }> {
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
    logIndex: 0,
    transactionIndex: 0,
    transactionHash: "0x",
  };
}

// export function buildV3Deposit(
//   _hubPoolClient: HubPoolClient,
//   _spokePool: Contract,
//   _destinationChainId: number,
//   _recipientAndDepositor: SignerWithAddress,
//   _inputToken: Contract,
//   _inputAmount: BigNumber,
//   _outputToken: Contract,
//   _outputAmount: BigNumber
// ): Promise<Deposit> {
//   throw new Error("not supported");
// }

// @note To be deprecated post-v3.
export async function buildV2Deposit(
  hubPoolClient: HubPoolClient,
  spokePool: Contract,
  tokenToDeposit: Contract,
  recipientAndDepositor: SignerWithAddress,
  destinationChainId: number,
  _amountToDeposit: BigNumber = constants.amountToDeposit,
  relayerFeePct: BigNumber = constants.depositRelayerFeePct
): Promise<V2Deposit> {
  const _deposit = await depositV2(
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
  const depositObject: V2PartialDeposit = {
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

  return await buildV2DepositStruct(depositObject, hubPoolClient);
}

export function getV2FillRelayParams(
  _relayData: V2RelayData,
  _maxTokensToSend: BigNumber,
  _repaymentChain?: number,
  _maxCount?: BigNumber
): string[] {
  return [
    _relayData.depositor,
    _relayData.recipient,
    _relayData.destinationToken,
    _relayData.amount.toString(),
    _maxTokensToSend.toString(),
    _repaymentChain ? _repaymentChain.toString() : constants.repaymentChainId.toString(),
    _relayData.originChainId.toString(),
    _relayData.realizedLpFeePct.toString(),
    _relayData.relayerFeePct.toString(),
    _relayData.depositId.toString(),
    _relayData.message || "0x",
    _maxCount ? _maxCount.toString() : constants.maxUint256.toString(),
  ];
}

export function getV2RelayHash(
  _depositor: string,
  _recipient: string,
  _depositId: number,
  _originChainId: number,
  _destinationChainId: number,
  _destinationToken: string,
  _amount?: BigNumber,
  _realizedLpFeePct?: BigNumber,
  _relayerFeePct?: BigNumber,
  _message?: string
): { relayHash: string; relayData: V2RelayData } {
  const relayData = {
    depositor: _depositor,
    recipient: _recipient,
    destinationToken: _destinationToken,
    amount: _amount || constants.amountToDeposit,
    originChainId: _originChainId,
    destinationChainId: _destinationChainId,
    realizedLpFeePct: _realizedLpFeePct || constants.realizedLpFeePct,
    relayerFeePct: _relayerFeePct || constants.depositRelayerFeePct,
    depositId: _depositId,
    message: _message || "0x",
  };
  const relayHash = ethers.utils.keccak256(
    ethersUtils.defaultAbiCoder.encode(
      [
        "tuple(address depositor, address recipient, address destinationToken, uint256 amount, uint256 originChainId, uint256 destinationChainId, int64 realizedLpFeePct, int64 relayerFeePct, uint32 depositId, bytes message)",
      ],
      [relayData]
    )
  );
  return { relayHash, relayData };
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
    ...getV2FillRelayParams(
      getV2RelayHash(
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

export async function modifyV2RelayHelper(
  modifiedRelayerFeePct: BigNumber,
  depositId: string,
  originChainId: string,
  depositor: SignerWithAddress,
  updatedRecipient: string,
  updatedMessage: string
): Promise<{ signature: string }> {
  const typedData = {
    types: {
      UpdateDepositDetails: [
        { name: "depositId", type: "uint32" },
        { name: "originChainId", type: "uint256" },
        { name: "updatedRelayerFeePct", type: "int64" },
        { name: "updatedRecipient", type: "address" },
        { name: "updatedMessage", type: "bytes" },
      ],
    },
    domain: {
      name: "ACROSS-V2",
      version: "1.0.0",
      chainId: Number(originChainId),
    },
    message: {
      depositId,
      originChainId,
      updatedRelayerFeePct: modifiedRelayerFeePct,
      updatedRecipient,
      updatedMessage,
    },
  };
  const signature = await depositor._signTypedData(typedData.domain, typedData.types, typedData.message);
  return {
    signature,
  };
}

export function getV2FillRelayUpdatedFeeParams(
  _relayData: V2RelayData,
  _maxTokensToSend: BigNumber,
  _updatedFee: BigNumber,
  _signature: string,
  _repaymentChain?: number,
  _updatedRecipient?: string,
  _updatedMessage?: string,
  _maxCount?: BigNumber
): string[] {
  return [
    _relayData.depositor,
    _relayData.recipient,
    _updatedRecipient || _relayData.recipient,
    _relayData.destinationToken,
    _relayData.amount.toString(),
    _maxTokensToSend.toString(),
    _repaymentChain ? _repaymentChain.toString() : constants.repaymentChainId.toString(),
    _relayData.originChainId.toString(),
    _relayData.realizedLpFeePct.toString(),
    _relayData.relayerFeePct.toString(),
    _updatedFee.toString(),
    _relayData.depositId.toString(),
    _relayData.message,
    _updatedMessage || _relayData.message,
    _signature,
    _maxCount ? _maxCount.toString() : constants.maxUint256.toString(),
  ];
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
    originChainId: fillToBuildFrom.originChainId,
    destinationChainId: fillToBuildFrom.destinationChainId,
    realizedLpFeePct: fillToBuildFrom.realizedLpFeePct,
    relayerFeePct: fillToBuildFrom.relayerFeePct,
    depositId: fillToBuildFrom.depositId,
    message: fillToBuildFrom.message,
  };

  const { signature } = await modifyV2RelayHelper(
    fillToBuildFrom.relayerFeePct.mul(multipleOfOriginalRelayerFeePct),
    fillToBuildFrom.depositId.toString(),
    fillToBuildFrom.originChainId.toString(),
    depositor,
    newRecipient ?? relayDataFromFill.recipient,
    newMessage ?? relayDataFromFill.message
  );
  const updatedRelayerFeePct = fillToBuildFrom.relayerFeePct.mul(multipleOfOriginalRelayerFeePct);
  await spokePool.connect(relayer).fillRelayWithUpdatedDeposit(
    ...getV2FillRelayUpdatedFeeParams(
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

export function buildV2DepositForRelayerFeeTest(
  amount: BigNumber,
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

/**
 * Find the amount filled for a deposit at a particular block.
 * @param spokePool SpokePool contract instance.
 * @param relayData Deposit information that is used to complete a fill.
 * @param blockTag Block tag (numeric or "latest") to query at.
 * @returns The amount filled for the specified deposit at the requested block (or latest).
 */
export async function relayFilledAmount(
  spokePool: Contract,
  relayData: RelayData,
  blockTag?: number | "latest"
): Promise<BigNumber> {
  const hash = getRelayDataHash(relayData);

  if (isV2RelayData(relayData)) {
    const fills = await spokePool.queryFilter(
      await spokePool.filters.FilledRelay(
        null,
        null,
        null,
        null,
        relayData.originChainId,
        null,
        null,
        null,
        relayData.depositId,
        null,
        null,
        null,
        null,
        null,
        null
      )
    );
    // TODO: For this to be safe in production, you'd need to get the hash of the events
    // to match against `hash`, but since this is used in tests only we can just match on originChainId and depositId.
    if (fills.length === 0) return bnZero;
    if (blockTag === "latest") return fills[fills.length - 1].args?.totalFilledAmount;
    else {
      // Return latest totalFilled amount before blockTag which would be equivalent to the total filled amount
      // as of the block tag.
      return (
        fills.find((e) => {
          if (blockTag === undefined) return e.args?.totalFilledAmount;
          else if (e.blockNumber <= blockTag) return e.args?.totalFilledAmount;
        })?.args?.totalFilledAmount ?? bnZero
      );
    }
  }

  const fillStatus = await spokePool.fillStatuses(hash, { blockTag });

  // @note: If the deposit was updated then the fill amount may be _less_ than outputAmount.
  // @todo: Remove V3RelayData type assertion once RelayData type is unionised.
  return fillStatus === FillStatus.Filled ? (relayData as V3RelayData).outputAmount : bnZero;
}

/**
 * Find the block at which a fill was completed.
 * @todo After SpokePool upgrade, this function can be simplified to use the FillStatus enum.
 * @param spokePool SpokePool contract instance.
 * @param relayData Deposit information that is used to complete a fill.
 * @param lowBlockNumber The lower bound of the search. Must be bounded by SpokePool deployment.
 * @param highBlocknumber Optional upper bound for the search.
 * @returns The block number at which the relay was completed, or undefined.
 */
export async function findFillBlock(
  spokePool: Contract,
  relayData: RelayData,
  lowBlockNumber: number,
  highBlockNumber?: number
): Promise<number | undefined> {
  const { provider } = spokePool;
  highBlockNumber ??= await provider.getBlockNumber();
  assert(highBlockNumber > lowBlockNumber, `Block numbers out of range (${lowBlockNumber} > ${highBlockNumber})`);
  const { chainId: destinationChainId } = await provider.getNetwork();

  // Make sure the relay is 100% completed within the block range supplied by the caller.
  const [initialFillAmount, finalFillAmount] = await Promise.all([
    relayFilledAmount(spokePool, relayData, lowBlockNumber),
    relayFilledAmount(spokePool, relayData, highBlockNumber),
  ]);

  // Wasn't filled within the specified block range.
  const relayAmount = getRelayDataOutputAmount(relayData);
  if (finalFillAmount.lt(relayAmount)) {
    return undefined;
  }

  // Was filled earlier than the specified lowBlock.. This is an error by the caller.
  if (initialFillAmount.eq(relayAmount)) {
    const { depositId, originChainId } = relayData;
    const [srcChain, dstChain] = [getNetworkName(originChainId), getNetworkName(destinationChainId)];
    throw new Error(`${srcChain} deposit ${depositId} filled on ${dstChain} before block ${lowBlockNumber}`);
  }

  // Find the leftmost block where filledAmount equals the deposit amount.
  do {
    const midBlockNumber = Math.floor((highBlockNumber + lowBlockNumber) / 2);
    const filledAmount = await relayFilledAmount(spokePool, relayData, midBlockNumber);

    if (filledAmount.eq(relayAmount)) {
      highBlockNumber = midBlockNumber;
    } else {
      lowBlockNumber = midBlockNumber + 1;
    }
  } while (lowBlockNumber < highBlockNumber);

  return lowBlockNumber;
}
