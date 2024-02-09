import { HardhatEthersHelpers } from "@nomiclabs/hardhat-ethers/types";
import type { BigNumber, Contract, ethers } from "ethers";
import winston from "winston";
import { sinon } from "../utils";

export type EthersTestLibrary = typeof ethers & HardhatEthersHelpers;
export type SpyLoggerResult = {
  spy: sinon.SinonSpy<unknown[], unknown>;
  spyLogger: winston.Logger;
};

export type SpokePoolDeploymentResult = {
  weth: Contract;
  erc20: Contract;
  spokePool: Contract;
  unwhitelistedErc20: Contract;
  destErc20: Contract;
  deploymentBlock: number;
};

export type ContractsV2SlowFillRelayData = {
  depositor: string;
  recipient: string;
  destinationToken: string;
  amount: BigNumber;
  realizedLpFeePct: BigNumber;
  relayerFeePct: BigNumber;
  depositId: string;
  originChainId: string;
  destinationChainId: string;
  message: string;
};

export type ContractsV2SlowFill = {
  relayData: ContractsV2SlowFillRelayData;
  payoutAdjustmentPct: BigNumber;
};
