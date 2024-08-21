import { BigNumber, Signer } from "ethers";
import { DepositWithBlock, FillWithBlock, Refund } from "./SpokePool";
import { HubPoolClient } from "../clients/HubPoolClient";
import { AcrossConfigStoreClient } from "../clients";
import { ArweaveClient } from "../caching";

export type ExpiredDepositsToRefundV3 = {
  [originChainId: number]: {
    [originToken: string]: DepositWithBlock[];
  };
};

export type BundleDepositsV3 = {
  [originChainId: number]: {
    [originToken: string]: DepositWithBlock[];
  };
};

export interface BundleFillV3 extends FillWithBlock {
  lpFeePct: BigNumber;
}

export type BundleFillsV3 = {
  [repaymentChainId: number]: {
    [repaymentToken: string]: {
      fills: BundleFillV3[];
      refunds: Refund;
      totalRefundAmount: BigNumber;
      realizedLpFees: BigNumber;
    };
  };
};

export type BundleExcessSlowFills = {
  [destinationChainId: number]: {
    [destinationToken: string]: (DepositWithBlock & { lpFeePct: BigNumber })[];
  };
};
export type BundleSlowFills = {
  [destinationChainId: number]: {
    [destinationToken: string]: (DepositWithBlock & { lpFeePct: BigNumber })[];
  };
};

export type LoadDataReturnValue = {
  bundleDepositsV3: BundleDepositsV3;
  expiredDepositsToRefundV3: ExpiredDepositsToRefundV3;
  bundleFillsV3: BundleFillsV3;
  unexecutableSlowFills: BundleExcessSlowFills;
  bundleSlowFillsV3: BundleSlowFills;
};

export type BundleData = LoadDataReturnValue & {
  bundleBlockRanges: number[][];
};

export interface Clients {
  hubPoolClient: HubPoolClient;
  configStoreClient: AcrossConfigStoreClient;
  hubSigner?: Signer;
  arweaveClient: ArweaveClient;
}

export type CombinedRefunds = {
  [repaymentChainId: number]: {
    [repaymentToken: string]: Refund;
  };
};
