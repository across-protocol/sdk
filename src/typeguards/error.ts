import { ethers } from "ethers";
import { BaseError } from "viem";
import { EthersError } from "../interfaces";

export { isSolanaError } from "../arch/svm";

export const isError = (error: unknown): error is Error => error instanceof Error;

export const isEthersError = (error?: unknown): error is EthersError =>
  (error as EthersError)?.code in ethers.utils.Logger.errors;

export const isViemError = (error?: unknown): error is BaseError => error instanceof BaseError;
