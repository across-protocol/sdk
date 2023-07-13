import { BigNumber } from "ethers";
import { UbaFlow } from "../../interfaces";
import { UBAActionType, FlowTupleParameters } from "../../UBAFeeCalculator/UBAFeeTypes";
import UBAConfig from "../../UBAFeeCalculator/UBAFeeConfig";

export type RequestValidReturnType = { valid: false; reason: string } | { valid: true };
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
  bundles: UBABundleTokenState;
};

export type UBABundleTokenState = {
  [tokenSymbol: string]: UBABundleState[];
};

export type ModifiedUBAFlow = {
  flow: UbaFlow;
  systemFee: SystemFeeResult;
  relayerFee: RelayerFeeResult;
  runningBalance: BigNumber;
  incentiveBalance: BigNumber;
  netRunningBalanceAdjustment: BigNumber;
};

type UBABundleConfig = {
  ubaConfig: UBAConfig;
  tokenDecimals: number;
  hubBalance: BigNumber;
  hubEquity: BigNumber;
  hubPoolSpokeBalance: BigNumber;
  spokeTargets: {
    spokeChainId: number;
    target: BigNumber;
  }[];
};

export type UBABundleState = {
  openingBalance: BigNumber;
  openingIncentiveBalance: BigNumber;
  openingBlockNumberForSpokeChain: number;
  config: UBABundleConfig;
  flows: ModifiedUBAFlow[];
};

export type UBALPFeeOverride = {
  decimals: number;
  hubBalance: BigNumber;
  hubEquity: BigNumber;
  ethSpokeBalance: BigNumber;
  spokeTargets: {
    spokeChainId: number;
    target: BigNumber;
  }[];
  baselineFee: BigNumber;
  gammaCutoff: FlowTupleParameters;
};

export type UBAClientState = {
  [chainId: number]: UBAChainState;
};
