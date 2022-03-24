import { BigNumberish } from "ethers";
import { ChainId } from "../../constants";

export type TransferStatus = "pending" | "filled";

export type Transfer = {
  depositId: number;
  depositTime: number;
  status: TransferStatus;
  filled: BigNumberish;
  sourceChainId: ChainId;
  destinationChainId: number;
  assetAddr: string;
  amount: BigNumberish;
  depositTxHash: string;
};

export type TransferFilters = {
  address?: string;
  status: TransferStatus;
};

type QueryProgress = { latestFromBlock?: number; latestToBlock?: number; latestFromTimestamp?: number };
type ChainQueryProgress = Record<number, QueryProgress>;

type ChainTransfers = {
  [chainId: number]: {
    [depositId: number]: Transfer;
  };
};

type BlockLowerBound = {
  [chainId: number]: number;
};

const blockLowerBoundInitialValues = {
  [ChainId.MAINNET]: 0,
  [ChainId.RINKEBY]: 0,
  [ChainId.KOVAN]: 0,
  [ChainId.OPTIMISM_KOVAN]: 0,
  [ChainId.ARBITRUM_RINKEBY]: 9828565,
};

export class State {
  public constructor(
    public completedTransfers: Transfer[] = [],
    public pendingTransfers: Transfer[] = [],
    public filters: TransferFilters | undefined = undefined,
    public progress: ChainQueryProgress = {},
    public chainTransfers: ChainTransfers = {},
    public blockLowerBound: BlockLowerBound = blockLowerBoundInitialValues
  ) {}

  public clean() {
    this.completedTransfers = [];
    this.pendingTransfers = [];
    this.filters = undefined;
    this.progress = {};
    this.chainTransfers = {};
  }

  public insertTransfer(chainId: number, depositId: number, transfer: Transfer) {
    if (!this.chainTransfers[chainId]) {
      this.chainTransfers[chainId] = {};
    }
    this.chainTransfers[chainId][depositId] = transfer;
  }

  public insertQueryProgress(chainId: ChainId, progress: QueryProgress) {
    this.progress[chainId] = progress;
  }

  public setLatestFromTimestamp(chainId: ChainId, from: number) {
    if (!this.progress[chainId]) {
      this.progress[chainId] = {};
    }
    const progress = this.progress[chainId];
    if (!progress || !progress.latestFromTimestamp || progress.latestFromTimestamp > from) {
      this.progress[chainId].latestFromTimestamp = from;
    }
  }

  public setLatestFromBlock(chainId: ChainId, from: number) {
    if (!this.progress[chainId]) {
      this.progress[chainId] = {};
    }
    const progress = this.progress[chainId];
    if (!progress.latestFromBlock || progress.latestFromBlock > from) {
      this.progress[chainId].latestFromBlock = from;
    }
  }

  public setLatestToBlock(chainId: ChainId, to: number) {
    if (!this.progress[chainId]) {
      this.progress[chainId] = {};
    }
    const progress = this.progress[chainId];
    if (!progress || !progress.latestToBlock || progress.latestToBlock < to) {
      this.progress[chainId].latestToBlock = to;
    }
  }
}
