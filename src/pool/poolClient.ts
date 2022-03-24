import assert from "assert";
import * as uma from "@uma/sdk";
import { toBNWei, fixedPointAdjustment, calcPeriodicCompoundInterest, calcApr, BigNumberish, fromWei } from "../utils";
import { ethers, Signer, BigNumber } from "ethers";
import type { Overrides } from "@ethersproject/contracts";
import { TransactionRequest, TransactionReceipt, Log } from "@ethersproject/abstract-provider";
import { Provider, Block } from "@ethersproject/providers";
import set from "lodash/set";
import get from "lodash/get";
import has from "lodash/has";
import { calculateInstantaneousRate } from "../lpFeeCalculator";
import { hubPool } from './contracts'
const { rateModelStore, erc20 } = uma.clients;

const { loop, exists } = uma.utils;
const {TransactionManager} = uma.across;
const { parseAndReturnRateModelFromString } = uma.across.rateModel
const { SECONDS_PER_YEAR, DEFAULT_BLOCK_DELTA} = uma.across.constants;

export type { Provider };

export type Awaited<T> = T extends PromiseLike<infer U> ? U : T;

export type Config = {
  hubPoolAddress: string;
  rateModelStoreAddress: string;
  confirmations?: number;
  blockDelta?: number;
};
export type Dependencies = {
  provider: Provider;
};
export type Pool = {
  address: string;
  totalPoolSize: string;
  l1Token: string;
  lpToken: string;
  liquidReserves: string;
  exchangeRateCurrent: string;
  exchangeRatePrevious: string;
  estimatedApy: string;
  estimatedApr: string;
  blocksElapsed: number;
  secondsElapsed: number;
  utilizedReserves: string;
  projectedApr: string;
};
export type User = {
  address: string;
  poolAddress: string;
  lpTokens: string;
  positionValue: string;
  totalDeposited: string;
  feesEarned: string;
};
export type Transaction = {
  id: string;
  state: "requested" | "submitted" | "mined" | "error";
  toAddress: string;
  fromAddress: string;
  type: "Add Liquidity" | "Remove Liquidity";
  description: string;
  request?: TransactionRequest;
  hash?: string;
  receipt?: TransactionReceipt;
  error?: Error;
};
export type Token = {
  decimals: string;
  symbol: string;
  name: string;
};
export type State = {
  pools: Record<string, Pool>;
  users: Record<string, Record<string, User>>;
  transactions: Record<string, Transaction>;
  error?: Error;
};
export type EmitState = (path: string[], data: any) => void;
export type PooledToken = {
  // LP token given to LPs of a specific L1 token.
  lpToken: string;
  // True if accepting new LP's.
  isEnabled: boolean;
  // Timestamp of last LP fee update.
  lastLpFeeUpdate: number;
  // Number of LP funds sent via pool rebalances to SpokePools and are expected to be sent
  // back later.
  utilizedReserves: BigNumber;
  // Number of LP funds held in contract less utilized reserves.
  liquidReserves: BigNumber;
  // Number of LP funds reserved to pay out to LPs as fees.
  undistributedLpFees: BigNumber;
}

class PoolState {
  constructor(
    private contract: hubPool.Instance,
    private address: string
  ) {}
  public async read(l1Token:string, latestBlock: number, previousBlock?: number) {
    // typechain does not have complete types for call options, so we have to cast blockTag to any
    const exchangeRatePrevious = await this.contract.callStatic.exchangeRateCurrent(l1Token,{
      blockTag: previousBlock || latestBlock - 1,
    } as any);

    const exchangeRateCurrent = await this.contract.callStatic.exchangeRateCurrent(l1Token);

    const pooledToken:PooledToken = await this.contract.pooledTokens(l1Token);

    return {
      address:this.address,
      l1Token,
      latestBlock,
      previousBlock,
      exchangeRatePrevious,
      exchangeRateCurrent,
      ...pooledToken,
    }

  }
}

type EventIdParams = { blockNumber: number; transactionIndex: number; logIndex: number };
export class PoolEventState {
  private seen = new Set<string>();
  private iface: ethers.utils.Interface;
  constructor(
    private contract: hubPool.Instance,
    private startBlock = 0,
    private state: hubPool.EventState = hubPool.eventStateDefaults()
  ) {
    this.iface = new ethers.utils.Interface(hubPool.Factory.abi);
  }
  private makeId(params: EventIdParams) {
    return [params.blockNumber, params.transactionIndex, params.logIndex].join("!");
  }
  hasEvent(params: EventIdParams) {
    return this.seen.has(this.makeId(params));
  }
  private addEvent(params: EventIdParams) {
    return this.seen.add(this.makeId(params));
  }
  private filterSeen = (params: EventIdParams) => {
    const seen = this.hasEvent(params);
    if (!seen) this.addEvent(params);
    return !seen;
  };
  public async read(endBlock: number) {
    if (endBlock <= this.startBlock) return this.state;
    const events = (
      await Promise.all([
        ...(await this.contract.queryFilter(this.contract.filters.LiquidityAdded(), this.startBlock, endBlock)),
        ...(await this.contract.queryFilter(this.contract.filters.LiquidityRemoved(), this.startBlock, endBlock)),
      ])
    )
      .filter(this.filterSeen)
      .sort((a, b) => {
        if (a.blockNumber !== b.blockNumber) return a.blockNumber - b.blockNumber;
        if (a.transactionIndex !== b.transactionIndex) return a.transactionIndex - b.transactionIndex;
        if (a.logIndex !== b.logIndex) return a.logIndex - b.logIndex;
        // if everything is the same, return a, ie maintain order of array
        return -1;
      });
    // ethers queries are inclusive [start,end] unless start === end, then exclusive (start,end). we increment to make sure we dont see same event twice
    this.startBlock = endBlock + 1;
    this.state = hubPool.getEventState(events, this.state);
    return this.state;
  }
  makeEventFromLog(log: Log) {
    const description = this.iface.parseLog(log);
    return {
      ...log,
      ...description,
      event: description.name,
      eventSignature: description.signature,
    };
  }
  getL1TokenFromReceipt(receipt:TransactionReceipt):string{
    const events = receipt.logs
      .map((log) => {
        try {
          return this.makeEventFromLog(log);
        } catch (err) {
          // return nothing, this throws a lot because logs from other contracts are included in receipt
          return undefined;
        }
      })
      // filter out undefined
      .filter(exists)

    const eventState = hubPool.getEventState(events)
    const l1Tokens = Object.keys(eventState)
    assert(l1Tokens.length,'Token not found from events')
    assert(l1Tokens.length === 1,'Multiple tokens found from events')
    return l1Tokens[0]
  }
  readTxReceipt(receipt: TransactionReceipt) {
    const events = receipt.logs
      .map((log) => {
        try {
          return this.makeEventFromLog(log);
        } catch (err) {
          // return nothing, this throws a lot because logs from other contracts are included in receipt
          return undefined;
        }
      })
      // filter out undefined
      .filter(exists)
      .filter(this.filterSeen);

    this.state = hubPool.getEventState(events, this.state);
    return this.state;
  }
}

class UserState {
  constructor(private contract: uma.clients.erc20.Instance) {}
  public async read(user: string) {
    return {
      address: user,
      balanceOf: await this.contract.balanceOf(user),
    };
  }
}

export function calculateRemoval(amountWei: BigNumber, percentWei: BigNumber) {
  const receive = amountWei.mul(percentWei).div(fixedPointAdjustment);
  const remain = amountWei.sub(receive);
  return {
    recieve: receive.toString(),
    remain: remain.toString(),
  };
}
// params here mimic the user object type
export function previewRemoval(
  values: { positionValue: BigNumberish; feesEarned: BigNumberish; totalDeposited: BigNumberish },
  percentFloat: number
) {
  const percentWei = toBNWei(percentFloat);
  return {
    position: {
      ...calculateRemoval(BigNumber.from(values.totalDeposited), percentWei),
    },
    fees: {
      ...calculateRemoval(BigNumber.from(values.feesEarned), percentWei),
    },
    total: {
      ...calculateRemoval(BigNumber.from(values.positionValue), percentWei),
    },
  };
}
function joinUserState(
  poolState: Pool,
  tokenEventState: hubPool.TokenEventState,
  userState: Awaited<ReturnType<UserState["read"]>>,
): User {
  const positionValue = BigNumber.from(poolState.exchangeRateCurrent)
    .mul(userState.balanceOf)
    .div(fixedPointAdjustment);
  const totalDeposited = BigNumber.from(tokenEventState.tokenBalances[userState.address] || "0");
  const feesEarned = positionValue.sub(totalDeposited);
  return {
    address: userState.address,
    poolAddress: poolState.address,
    lpTokens: userState.balanceOf.toString(),
    positionValue: positionValue.toString(),
    totalDeposited: totalDeposited.toString(),
    feesEarned: feesEarned.toString(),
  };
}
function joinPoolState(
  poolState: Awaited<ReturnType<PoolState["read"]>>,
  latestBlock: Block,
  previousBlock: Block,
  rateModel?: uma.across.constants.RateModel
): Pool {
  const totalPoolSize = poolState.liquidReserves.add(poolState.utilizedReserves);
  const secondsElapsed = latestBlock.timestamp - previousBlock.timestamp;
  const blocksElapsed = latestBlock.number - previousBlock.number;
  const exchangeRatePrevious = poolState.exchangeRatePrevious.toString();
  const exchangeRateCurrent = poolState.exchangeRateCurrent.toString();

  const estimatedApy = calcPeriodicCompoundInterest(
    exchangeRatePrevious,
    exchangeRateCurrent,
    secondsElapsed,
    SECONDS_PER_YEAR
  );
  const estimatedApr = calcApr(exchangeRatePrevious, exchangeRateCurrent, secondsElapsed, SECONDS_PER_YEAR);
  let projectedApr = "";

  if (rateModel) {
    projectedApr = fromWei(
      calculateInstantaneousRate(rateModel, poolState.utilizedReserves)
        .mul(poolState.utilizedReserves)
        .div(fixedPointAdjustment)
    );
  }

  return {
    address: poolState.address,
    totalPoolSize: totalPoolSize.toString(),
    l1Token: poolState.l1Token,
    lpToken: poolState.lpToken,
    liquidReserves: poolState.liquidReserves.toString(),
    exchangeRateCurrent: poolState.exchangeRateCurrent.toString(),
    exchangeRatePrevious: poolState.exchangeRatePrevious.toString(),
    estimatedApy,
    estimatedApr,
    blocksElapsed,
    secondsElapsed,
    projectedApr,
    utilizedReserves: poolState.utilizedReserves.toString(),
  };
}
export class ReadPoolClient {
  private poolState: PoolState;
  private contract: hubPool.Instance;
  constructor(private address: string, private provider: Provider) {
    this.contract = hubPool.connect(address, this.provider);
    this.poolState = new PoolState(this.contract, this.address);
  }
  public async read(tokenAddress:string, latestBlock: number) {
    return this.poolState.read(tokenAddress, latestBlock);
  }
}
export function validateWithdraw(pool: Pool, user: User, lpTokenAmount: BigNumberish) {
  const l1TokensToReturn = BigNumber.from(lpTokenAmount).mul(pool.exchangeRateCurrent).div(fixedPointAdjustment);
  assert(BigNumber.from(l1TokensToReturn).gt("0"), "Must withdraw amount greater than 0");
  assert(BigNumber.from(lpTokenAmount).lte(user.lpTokens), "You cannot withdraw more than you have");
  return { lpTokenAmount, l1TokensToReturn: l1TokensToReturn.toString() };
}

export class Client {
  private transactionManagers: Record<string, ReturnType<typeof TransactionManager>> = {};
  private hubPool: hubPool.Instance;
  private state: State = { pools: {}, users: {}, transactions: {} };
  private poolEvents: PoolEventState;
  private erc20s:Record<string, uma.clients.erc20.Instance> = {};
  private intervalStarted = false;
  private rateModelInstance: uma.clients.rateModelStore.Instance;
  constructor(private config: Config, private deps: Dependencies, private emit: EmitState) {
    this.hubPool = hubPool.connect(config.hubPoolAddress,deps.provider)
    this.poolEvents = new PoolEventState(this.hubPool);
    this.rateModelInstance = rateModelStore.connect(config.rateModelStoreAddress, deps.provider);
  }
  private getOrCreateErc20Contract(address:string){
    if(this.erc20s[address]) return this.erc20s[address]
    this.erc20s[address] = erc20.connect(address,this.deps.provider)
    return this.erc20s[address]
  }
  private getOrCreatePoolContract() {
    return this.hubPool
  }
  private getOrCreatePoolEvents() {
    return this.poolEvents
  }
  private getOrCreateTransactionManager(signer: Signer, address: string) {
    if (this.transactionManagers[address]) return this.transactionManagers[address];
    const txman = TransactionManager({ confirmations: this.config.confirmations }, signer, (event, id, data) => {
      if (event === "submitted") {
        this.state.transactions[id].state = event;
        this.state.transactions[id].hash = data as string;
        this.emit(["transactions", id], { ...this.state.transactions[id] });
      }
      if (event === "mined") {
        const txReceipt = data as TransactionReceipt;
        this.state.transactions[id].state = event;
        this.state.transactions[id].receipt = txReceipt;
        this.emit(["transactions", id], { ...this.state.transactions[id] });
        // trigger pool and user update for a known mined transaction
        const tx = this.state.transactions[id];
        this.updateUserWithTransaction(tx.fromAddress, txReceipt).catch((err) => {
            this.emit(["error"], err);
          });
      }
      if (event === "error") {
        this.state.transactions[id].state = event;
        this.state.transactions[id].error = data as Error;
        this.emit(["transactions", id], { ...this.state.transactions[id] });
      }
    });
    this.transactionManagers[address] = txman;
    return txman;
  }
  async addEthLiquidity(signer: Signer, pool: string, l1Token:string, l1TokenAmount: BigNumberish, overrides: Overrides = {}) {
    const userAddress = await signer.getAddress();
    const contract = this.getOrCreatePoolContract();
    const txman = this.getOrCreateTransactionManager(signer, userAddress);

    // dont allow override value here
    const request = await contract.populateTransaction.addLiquidity(l1Token,l1TokenAmount, {
      ...overrides,
      value: l1TokenAmount,
    });
    const id = await txman.request(request);

    this.state.transactions[id] = {
      id,
      state: "requested",
      toAddress: pool,
      fromAddress: userAddress,
      type: "Add Liquidity",
      description: `Adding ETH to pool`,
      request,
    };
    this.emit(["transactions", id], { ...this.state.transactions[id] });
    await txman.update();
    return id;
  }
  async addTokenLiquidity(signer: Signer, pool: string, l1Token:string, l1TokenAmount: BigNumberish, overrides: Overrides = {}) {
    const userAddress = await signer.getAddress();
    const contract = this.getOrCreatePoolContract();
    const txman = this.getOrCreateTransactionManager(signer, userAddress);

    const request = await contract.populateTransaction.addLiquidity(l1Token,l1TokenAmount, overrides);
    const id = await txman.request(request);

    this.state.transactions[id] = {
      id,
      state: "requested",
      toAddress: pool,
      fromAddress: userAddress,
      type: "Add Liquidity",
      description: `Adding Tokens to pool`,
      request,
    };

    this.emit(["transactions", id], { ...this.state.transactions[id] });
    await txman.update();
    return id;
  }
  async validateWithdraw(l1Token: string, userAddress: string, lpAmount: BigNumberish) {
    await this.updatePool(l1Token);
    const poolState = this.getPoolState(l1Token);
    if (!this.hasUserState(l1Token, userAddress)) {
      await this.updateUser(l1Token, userAddress);
    }
    const userState = this.getUserState(poolState.lpToken, userAddress);
    return validateWithdraw(poolState, userState, lpAmount);
  }
  async removeTokenLiquidity(signer: Signer, pool: string, l1Token:string, lpTokenAmount: BigNumberish, overrides: Overrides = {}) {
    const userAddress = await signer.getAddress();
    await this.validateWithdraw(pool, userAddress, lpTokenAmount);
    const contract = this.getOrCreatePoolContract();
    const txman = this.getOrCreateTransactionManager(signer, userAddress);

    const request = await contract.populateTransaction.removeLiquidity(l1Token,lpTokenAmount, false, overrides);
    const id = await txman.request(request);

    this.state.transactions[id] = {
      id,
      state: "requested",
      toAddress: pool,
      fromAddress: userAddress,
      type: "Remove Liquidity",
      description: `Withdrawing Tokens from pool`,
      request,
    };

    this.emit(["transactions", id], { ...this.state.transactions[id] });
    await txman.update();
    return id;
  }
  async removeEthliquidity(signer: Signer, pool: string, l1Token:string, lpTokenAmount: BigNumberish, overrides: Overrides = {}) {
    const userAddress = await signer.getAddress();
    await this.validateWithdraw(pool, userAddress, lpTokenAmount);
    const contract = this.getOrCreatePoolContract();
    const txman = this.getOrCreateTransactionManager(signer, userAddress);

    const request = await contract.populateTransaction.removeLiquidity(l1Token, lpTokenAmount, true, overrides);
    const id = await txman.request(request);

    this.state.transactions[id] = {
      id,
      state: "requested",
      toAddress: pool,
      fromAddress: userAddress,
      type: "Remove Liquidity",
      description: `Withdrawing Eth from pool`,
      request,
    };
    this.emit(["transactions", id], { ...this.state.transactions[id] });
    await txman.update();
    return id;
  }
  getPoolState(l1TokenAddress: string):Pool {
    return this.state.pools[l1TokenAddress];
  }
  hasPoolState(l1TokenAddress: string):boolean {
    return Boolean(this.state.pools[l1TokenAddress]);
  }
  setUserState(l1TokenAddress:string, userAddress:string, state:User):User{
    set(this.state, ["users", userAddress, l1TokenAddress], state);
    return state
  }
  getUserState(l1TokenAddress: string, userAddress: string):User {
    return get(this.state, ["users", userAddress, l1TokenAddress]);
  }
  hasUserState(l1TokenAddress: string, userAddress: string):boolean {
    return has(this.state, ["users", userAddress, l1TokenAddress]);
  }
  hasTxState(id: string):boolean {
    return has(this.state, ["transactions", id]);
  }
  getTxState(id: string):Transaction {
    return get(this.state, ["transactions", id]);
  }
  private async updateUserWithTransaction(userAddress: string, txReceipt: TransactionReceipt):Promise<void> {
    const getPoolEventState = this.getOrCreatePoolEvents();
    const l1TokenAddress = getPoolEventState.getL1TokenFromReceipt(txReceipt);
    await this.updatePool(l1TokenAddress);
    const poolState = this.getPoolState(l1TokenAddress);
    const lpToken = poolState.lpToken;
    const erc20Contract = this.getOrCreateErc20Contract(lpToken)
    const getUserState = new UserState(erc20Contract);
    const userState = await getUserState.read(userAddress);
    const eventState = await getPoolEventState.readTxReceipt(txReceipt);
    const tokenEventState = eventState[l1TokenAddress]
    const newUserState = this.setUserState(l1TokenAddress,userAddress,joinUserState(poolState, tokenEventState, userState))
    this.emit(["users", userAddress, l1TokenAddress], newUserState)
  }
  async updateUser(userAddress: string, l1TokenAddress: string):Promise<void> {
    await this.updatePool(l1TokenAddress);
    const poolState = this.getPoolState(l1TokenAddress);
    const lpToken = poolState.lpToken;
    const latestBlock = (await this.deps.provider.getBlock("latest")).number;
    const erc20Contract = this.getOrCreateErc20Contract(lpToken)
    const getUserState = new UserState(erc20Contract);
    const getPoolEventState = this.getOrCreatePoolEvents();
    const userState = await getUserState.read(userAddress);
    const eventState = await getPoolEventState.read(latestBlock);
    const tokenEventState = eventState[l1TokenAddress]
    const newUserState = this.setUserState(l1TokenAddress,userAddress,joinUserState(poolState, tokenEventState, userState))
    this.emit(["users", userAddress, l1TokenAddress], newUserState)
  }
  async updatePool(l1TokenAddress:string):Promise<void> {
    // default to 100 block delta unless specified otherwise in config
    const { blockDelta = DEFAULT_BLOCK_DELTA } = this.config;
    const contract = this.getOrCreatePoolContract();
    const pool = new PoolState(contract,this.config.hubPoolAddress);
    const latestBlock = await this.deps.provider.getBlock("latest");
    const previousBlock = await this.deps.provider.getBlock(latestBlock.number - blockDelta);
    const state = await pool.read(l1TokenAddress,latestBlock.number, previousBlock.number);

    let rateModel: uma.across.constants.RateModel | undefined = undefined;
    try {
      const rateModelRaw = await this.rateModelInstance.callStatic.l1TokenRateModels(state.l1Token);
      rateModel = parseAndReturnRateModelFromString(rateModelRaw);
    } catch (err) {
      // we could swallow this error or just log it since getting the rate model is optional,
      // but we will just emit it to the caller and let them decide what to do with it.
      this.emit(["error"], err);
    }

    this.state.pools[l1TokenAddress] = joinPoolState(state, latestBlock, previousBlock, rateModel);
    this.emit(["pools", l1TokenAddress], this.state.pools[l1TokenAddress]);
  }
  async updateTransactions():Promise<void> {
    for (const txMan of Object.values(this.transactionManagers)) {
      try {
        await txMan.update();
      } catch (err) {
        this.emit(["error"], err);
      }
    }
  }
  // starts transaction checking intervals, defaults to 30 seconds
  async startInterval(delayMs = 30000) {
    assert(!this.intervalStarted, "Interval already started, try stopping first");
    this.intervalStarted = true;
    loop(async () => {
      assert(this.intervalStarted, "HubPool Interval Stopped");
      await this.updateTransactions();
    }, delayMs).catch((err) => {
      this.emit(["error"], err);
    });
  }
  // starts transaction checking intervals
  async stopInterval() {
    this.intervalStarted = false;
  }
}
