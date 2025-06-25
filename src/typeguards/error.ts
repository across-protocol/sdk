import { ethers } from "ethers";
import { EthersError } from "../interfaces";
import { BaseError } from "viem";

export const isError = (error: unknown): error is Error => error instanceof Error;

export const isEthersError = (error?: unknown): error is EthersError =>
  (error as EthersError)?.code in ethers.utils.Logger.errors;

export const isViemError = (error?: unknown): error is BaseError => error instanceof BaseError;
