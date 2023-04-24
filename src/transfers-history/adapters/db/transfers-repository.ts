import { BigNumber } from "ethers";
import { Transfer } from "../../model";
import { ChainId, CHAIN_IDs } from "../web3/model";

type TransfersStore = {
  [chainId: number]: {
    [address: string]: {
      [depositId: number]: Transfer;
    };
  };
};

type UsersTransfersStore = {
  [address: string]: {
    pending: Transfer[];
    filled: Transfer[];
  };
};

const usersTransfersStoreInitialValue: UsersTransfersStore = {};

const transfersStoreInitialValue: TransfersStore = {
  [CHAIN_IDs.GOERLI]: {},
  [CHAIN_IDs.POLYGON]: {},
  [CHAIN_IDs.MAINNET]: {},
};

export class TransfersRepository {
  public transfers: TransfersStore = transfersStoreInitialValue;
  public usersTransfers: UsersTransfersStore = usersTransfersStoreInitialValue;

  public insertTransfer(chainId: ChainId, depositorAddr: string, depositId: number, transfer: Transfer) {
    if (!this.transfers[chainId]) {
      this.transfers[chainId] = {};
    }

    if (!this.transfers[chainId][depositorAddr]) {
      this.transfers[chainId][depositorAddr] = {};
    }

    if (this.transfers[chainId][depositorAddr][depositId]) {
      return;
    }

    this.transfers[chainId][depositorAddr][depositId] = transfer;
  }

  public updateFilledAmount(
    chainId: ChainId,
    depositorAddr: string,
    depositId: number,
    filled: BigNumber,
    fillTxHash: string,
    appliedRelayerFeePct: BigNumber
  ) {
    const transfer = this.transfers?.[chainId]?.[depositorAddr]?.[depositId];
    if (!transfer) {
      console.error(`couldn't fill deposit on chain ${chainId}, depositId ${depositId}, depositor ${depositorAddr}`);
      return;
    }

    this.transfers[chainId][depositorAddr][depositId] = {
      ...transfer,
      filled,
      status: transfer.amount.eq(filled) ? "filled" : "pending",
      fillTxs: Array.from(new Set([...transfer.fillTxs, fillTxHash])),
      currentRelayerFeePct: appliedRelayerFeePct,
    };
  }

  public updateRelayerFee(
    sourceChainId: number,
    depositorAddr: string,
    depositId: number,
    newRelayerFeePct: BigNumber,
    speedUpTxHash: string,
    timestamp: number
  ) {
    const transfer = this.transfers?.[sourceChainId]?.[depositorAddr]?.[depositId];

    if (!transfer) {
      console.error(
        `couldn't update 'relayerFee' on chain ${sourceChainId}, depositId ${depositId}, depositor ${depositorAddr}`
      );
      return;
    }

    this.transfers[transfer.sourceChainId][depositorAddr][depositId] = {
      ...transfer,
      currentRelayerFeePct: transfer.status === "pending" ? newRelayerFeePct : transfer.currentRelayerFeePct,
      speedUps: [
        // remove possible duplicates
        ...transfer.speedUps.filter((speedUp) => speedUp.txHash !== speedUpTxHash),
        {
          txHash: speedUpTxHash,
          relayerFeePct: newRelayerFeePct,
          timestamp,
        },
      ],
    };
  }

  public getTransfersByChainAndDepositor(chainId: ChainId, depositorAddr: string) {
    if (this.transfers[chainId][depositorAddr]) {
      return Object.values(this.transfers[chainId][depositorAddr]);
    }

    return [];
  }

  public setDepositorPendingTransfers(depositorAddr: string, transfers: Transfer[]) {
    if (!this.usersTransfers[depositorAddr]) {
      this.usersTransfers[depositorAddr] = { pending: [], filled: [] };
    }
    this.usersTransfers[depositorAddr].pending = transfers;
  }

  public setDepositorFilledTransfers(depositorAddr: string, transfers: Transfer[]) {
    if (!this.usersTransfers[depositorAddr]) {
      this.usersTransfers[depositorAddr] = { filled: [], pending: [] };
    }

    this.usersTransfers[depositorAddr].filled = transfers;
  }

  public aggregateTransfers() {
    const chainsIds = Object.keys(this.transfers).map((chainId) => parseInt(chainId));
    const depositors = chainsIds.reduce(
      (acc, chainId) => [...acc, ...Object.keys(this.transfers[chainId])],
      [] as string[]
    );

    for (const depositorAddr of depositors) {
      const transfers: Transfer[] = [];

      for (const chainId of chainsIds) {
        transfers.push(...this.getTransfersByChainAndDepositor(chainId, depositorAddr));
      }

      // sort transfers by deposit time in descending order
      transfers.sort((t1, t2) => t2.depositTime - t1.depositTime);

      // filter events by status
      const filteredTransfers = transfers.reduce(
        (acc, transfer) => ({
          pending: transfer.status === "pending" ? [...acc.pending, transfer] : acc.pending,
          filled: transfer.status === "filled" ? [...acc.filled, transfer] : acc.filled,
        }),
        { pending: [] as Transfer[], filled: [] as Transfer[] }
      );

      this.setDepositorFilledTransfers(depositorAddr, filteredTransfers.filled);
      this.setDepositorPendingTransfers(depositorAddr, filteredTransfers.pending);
    }
  }

  public getFilledTransfers(depositorAddr: string, limit?: number, offset?: number) {
    const transfers = this.usersTransfers[depositorAddr]?.filled || [];

    if (transfers.length === 0) {
      return transfers;
    }

    return transfers.slice(offset, limit && offset ? limit + offset : limit);
  }

  public getAllFilledTransfers(limit?: number, offset?: number) {
    return Object.values(this.usersTransfers)
      .flatMap((t) => t.filled)
      .sort((t1, t2) => t2.depositTime - t1.depositTime)
      .slice(offset, limit && offset ? limit + offset : limit);
  }

  public getPendingTransfers(depositorAddr: string, limit?: number, offset?: number) {
    const transfers = this.usersTransfers[depositorAddr]?.pending || [];

    if (transfers.length === 0) {
      return transfers;
    }

    return transfers.slice(offset, limit && offset ? limit + offset : limit);
  }

  public getAllPendingTransfers(limit?: number, offset?: number) {
    return Object.values(this.usersTransfers)
      .flatMap((t) => t.pending)
      .sort((t1, t2) => t2.depositTime - t1.depositTime)
      .slice(offset, limit && offset ? limit + offset : limit);
  }

  public countFilledTransfers(depositorAddr: string) {
    const transfers = this.usersTransfers[depositorAddr]?.filled || [];
    return transfers.length;
  }

  public countAllFilledTransfers() {
    return Object.values(this.usersTransfers).flatMap((t) => t.filled).length;
  }

  public countPendingTransfers(depositorAddr: string) {
    const transfers = this.usersTransfers[depositorAddr]?.pending || [];
    return transfers.length;
  }

  public countAllPendingTransfers() {
    return Object.values(this.usersTransfers).flatMap((t) => t.pending).length;
  }
}
