import * as contracts from "@across-protocol/contracts-v2/dist/test-utils"; // Contains all the Across contract constants.
import { DEFAULT_CONFIG_STORE_VERSION } from "./mocks";

export const {
  amountToDeposit,
  amountToLp,
  depositRelayerFeePct,
  originChainId,
  destinationChainId,
  repaymentChainId,
  mockTreeRoot,
  refundProposalLiveness,
  totalBond,
} = contracts;
export const CONFIG_STORE_VERSION = DEFAULT_CONFIG_STORE_VERSION;
export const randomL1Token = contracts.randomAddress();
export const randomOriginToken = contracts.randomAddress();
export const randomDestinationToken = contracts.randomAddress();
export const randomDestinationToken2 = contracts.randomAddress();

// Max number of refunds in relayer refund leaf for a { repaymentChainId, L2TokenAddress }.
export const MAX_REFUNDS_PER_RELAYER_REFUND_LEAF = 3;

// Max number of L1 tokens for a chain ID in a pool rebalance leaf.
export const MAX_L1_TOKENS_PER_POOL_REBALANCE_LEAF = 3;

// DAI's Rate model.
export const sampleRateModel = {
  UBar: contracts.toWei(0.8).toString(),
  R0: contracts.toWei(0.04).toString(),
  R1: contracts.toWei(0.07).toString(),
  R2: contracts.toWei(0.75).toString(),
};

// Add Mainnet chain ID 1 to the chain ID list because the dataworker uses this chain to look up latest GlobalConfig
// updates for config variables like MAX_REFUND_COUNT_FOR_RELAYER_REPAYMENT_LEAF.
export const CHAIN_ID_TEST_LIST = [originChainId, destinationChainId, repaymentChainId, 1];
