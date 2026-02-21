// Note: this file sits on a separate export path and is intended to export test utilities.
// You can import it like this: import * as testUtils from "@across-protocol/sdk/test-utils".
// This is separated because this code assumes the caller has a hardhat config because it imports
// hardhat. For non-test code, import the standard index file:
// import * as sdk from "@across-protocol/sdk"

// Export from utils first (primary source for randomAddress, zeroAddress)
export * from "./test/utils/utils";

// Export from constants, excluding duplicates that come from utils
export {
  TokenRolesEnum,
  destinationChainId,
  originChainId,
  repaymentChainId,
  maxUint256,
  MAX_UINT32,
  MAX_EXCLUSIVITY_OFFSET_SECONDS,
  amountToSeedWallets,
  amountToLp,
  amountToDeposit,
  amountToRelay,
  depositRelayerFeePct,
  modifiedRelayerFeePct,
  incorrectModifiedRelayerFeePct,
  realizedLpFeePct,
  oneHundredPct,
  totalPostFeesPct,
  totalPostModifiedFeesPct,
  amountToRelayPreFees,
  amountReceived,
  amountToRelayPreModifiedFees,
  amountToRelayPreLPFee,
  firstDepositId,
  bondAmount,
  finalFee,
  finalFeeUsdc,
  finalFeeUsdt,
  totalBond,
  refundProposalLiveness,
  zeroAddress,
  zeroBytes32,
  identifier,
  zeroRawValue,
  mockBundleEvaluationBlockNumbers,
  mockPoolRebalanceLeafCount,
  mockPoolRebalanceRoot,
  mockRelayerRefundRoot,
  mockSlowRelayRoot,
  mockTreeRoot,
  amountHeldByPool,
  amountToReturn,
  sampleL2Gas,
  sampleL2GasSendTokens,
  sampleL2MaxSubmissionCost,
  sampleL2GasPrice,
  maxRefundsPerRelayerRefundLeaf,
  maxL1TokensPerPoolRebalanceLeaf,
  l1TokenTransferThreshold,
  MAX_REFUNDS_PER_RELAYER_REFUND_LEAF,
  MAX_L1_TOKENS_PER_POOL_REBALANCE_LEAF,
  sampleRateModel,
  CONFIG_STORE_VERSION,
  randomAddress,
  randomL1Token,
  randomOriginToken,
  randomDestinationToken,
  randomDestinationToken2,
  CHAIN_ID_TEST_LIST,
} from "./test/constants";

// Export from fixtures, excluding zeroAddress which is already exported from utils
export { deploySpokePool, spokePoolFixture } from "./test/fixtures/SpokePool.Fixture";
export { deployHubPool, hubPoolFixture } from "./test/fixtures/HubPool.Fixture";

// Export MerkleLib utilities (already re-exported by utils, but keep for clarity)
export {
  buildPoolRebalanceLeafTree,
  buildPoolRebalanceLeaves,
  buildRelayerRefundTree,
  buildRelayerRefundLeaves,
  buildSlowRelayTree,
  buildV3SlowRelayTree,
  getParamType,
} from "./test/utils/MerkleLib.utils";

// Export types
export * from "./test/types";
