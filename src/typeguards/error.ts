import { ethers } from "ethers";
import { EthersError } from "../interfaces";

export const isEthersError = (error?: unknown): error is EthersError =>
  (error as EthersError)?.code in ethers.utils.Logger.errors;
