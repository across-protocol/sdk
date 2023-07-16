import { BigNumber } from "ethers";
import { FillWithBlock, UbaFlow } from "../../interfaces";
import { UBAActionType, FlowTupleParameters } from "../../UBAFeeCalculator/UBAFeeTypes";
import UBAConfig from "../../UBAFeeCalculator/UBAFeeConfig";

// @todo: Revert to this after bumping typescript: { valid: true, fill: FillWithBlock } | { valid: false, reason: string } ;
export type RequestValidReturnType = { valid: boolean; reason?: string; matchingFill?: FillWithBlock };
export type BalancingFeeReturnType = { balancingFee: BigNumber; actionType: UBAActionType };
export type SystemFeeResult = { lpFee: BigNumber; depositBalancingFee: BigNumber; systemFee: BigNumber };
export type RelayerFeeResult = {
  relayerBalancingFee: BigNumber;
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
