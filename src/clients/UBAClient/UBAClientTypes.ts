import { BigNumber } from "ethers";
import { UbaFlow } from "../../interfaces";
import { UBAActionType } from "../../UBAFeeCalculator/UBAFeeTypes";
import UBAConfig from "../../UBAFeeCalculator/UBAFeeConfig";

export type RequestValidReturnType = { valid: false; reason: string } | { valid: true };
export type OpeningBalanceReturnType = { blockNumber: number; spokePoolBalance: BigNumber };
export type BalancingFeeReturnType = { balancingFee: BigNumber; actionType: UBAActionType };
export type SystemFeeResult = { lpFee: BigNumber; depositBalancingFee: BigNumber; systemFee: BigNumber };
export type RelayerFeeResult = {
  relayerGasFee: BigNumber;
  relayerCapitalFee: BigNumber;
  relayerBalancingFee: BigNumber;
  relayerFee: BigNumber;
  amountTooLow: boolean;
};

export type UBAChainState = {
  spokeChain: {
    deploymentBlockNumber: number;
    bundleEndBlockNumber: number;
    latestBlockNumber: number;
  };
  bundles: {
    [tokenSymbol: string]: UBABundleState[];
  };
};

export type UBABundleState = {
  openingBalance: BigNumber;
  openingIncentiveBalance: BigNumber;
  blockNumber: number;
  config: {
    ubaConfig: UBAConfig;
  };
  flows: {
    flow: UbaFlow;
    systemFee: SystemFeeResult;
    relayerFee: RelayerFeeResult;
    runningBalance: BigNumber;
    incentiveBalance: BigNumber;
    netRunningBalanceAdjustment: BigNumber;
  }[];
};
