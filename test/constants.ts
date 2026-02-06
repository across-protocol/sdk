import { BigNumber, ethers } from "ethers";
import { toWei, toBN, toBNWei, utf8ToHex } from "../src/utils";
import { ZERO_ADDRESS } from "../src/constants";
import { DEFAULT_CONFIG_STORE_VERSION } from "./mocks";

// Re-export TokenRolesEnum locally instead of from @uma/common
export const TokenRolesEnum = {
  OWNER: "0",
  MINTER: "1",
  BURNER: "3",
};

// Chain IDs
export const destinationChainId = 1342; // Should be equal to MockSpokePool.chainId() return value.
export const originChainId = 666;
export const repaymentChainId = 777;

// Max values
export const maxUint256 = ethers.constants.MaxInt256;
export const MAX_UINT32 = BigNumber.from("0xFFFFFFFF");
export const MAX_EXCLUSIVITY_OFFSET_SECONDS = 24 * 60 * 60 * 365;

// Seed / LP / deposit / relay amounts
export const amountToSeedWallets = toWei("1500");
export const amountToLp = toWei("1000");
export const amountToDeposit = toWei("100");
export const amountToRelay = toWei("25");

// Fee percentages (wei-scaled)
export const depositRelayerFeePct = toWei("0.1");
export const modifiedRelayerFeePct = toBN(depositRelayerFeePct).add(toBN(toWei("0.1")));
export const incorrectModifiedRelayerFeePct = toBN(modifiedRelayerFeePct).add(toBN(toWei("0.01")));
export const realizedLpFeePct = toWei("0.1");
export const oneHundredPct = toWei("1");

// Computed fee percentages
export const totalPostFeesPct = toBN(oneHundredPct).sub(toBN(depositRelayerFeePct).add(realizedLpFeePct));
export const totalPostModifiedFeesPct = toBN(oneHundredPct).sub(toBN(modifiedRelayerFeePct).add(realizedLpFeePct));

// Computed relay amounts
export const amountToRelayPreFees = toBN(amountToRelay).mul(toBN(oneHundredPct)).div(totalPostFeesPct);
export const amountReceived = toBN(amountToDeposit).mul(toBN(totalPostFeesPct)).div(toBN(oneHundredPct));
export const amountToRelayPreModifiedFees = toBN(amountToRelay).mul(toBN(oneHundredPct)).div(totalPostModifiedFeesPct);
export const amountToRelayPreLPFee = amountToRelayPreFees
  .mul(oneHundredPct.sub(realizedLpFeePct))
  .div(oneHundredPct);

// Deposit ID
export const firstDepositId = toBN(0);

// Bond and fee values
export const bondAmount = toWei("5");
export const finalFee = toWei("1");
export const finalFeeUsdc = ethers.utils.parseUnits("1", 6);
export const finalFeeUsdt = ethers.utils.parseUnits("1", 6);
export const totalBond = bondAmount.add(finalFee);

// Liveness
export const refundProposalLiveness = 7200;

// Addresses
export const zeroAddress = ZERO_ADDRESS;
export const zeroBytes32 = "0x0000000000000000000000000000000000000000000000000000000000000000";

// Identifier
export const identifier = utf8ToHex("ACROSS-V2");

// Raw value
export const zeroRawValue = { rawValue: "0" };

// Merkle tree / bundle mock data
export const mockBundleEvaluationBlockNumbers = [1, 2, 3];
export const mockPoolRebalanceLeafCount = 5;
export const mockPoolRebalanceRoot = ethers.utils.hexlify(ethers.utils.randomBytes(32));
export const mockRelayerRefundRoot = ethers.utils.hexlify(ethers.utils.randomBytes(32));
export const mockSlowRelayRoot = ethers.utils.hexlify(ethers.utils.randomBytes(32));
export const mockTreeRoot = ethers.utils.hexlify(ethers.utils.randomBytes(32));

// Pool amounts
export const amountHeldByPool = amountToRelay.mul(4);
export const amountToReturn = toWei("1");

// L2 gas parameters
export const sampleL2Gas = 2000000;
export const sampleL2GasSendTokens = 300000;
export const sampleL2MaxSubmissionCost = toWei("0.01");
export const sampleL2GasPrice = 5e9;

// Leaf size limits (lowercase versions matching contracts repo)
export const maxRefundsPerRelayerRefundLeaf = 3;
export const maxL1TokensPerPoolRebalanceLeaf = 3;

// L1 token transfer threshold
export const l1TokenTransferThreshold = toWei(100);

// Uppercase versions used by SDK tests
export const MAX_REFUNDS_PER_RELAYER_REFUND_LEAF = 3;
export const MAX_L1_TOKENS_PER_POOL_REBALANCE_LEAF = 3;

// DAI's Rate model.
export const sampleRateModel = {
  UBar: toWei(0.8).toString(),
  R0: toWei(0.04).toString(),
  R1: toWei(0.07).toString(),
  R2: toWei(0.75).toString(),
};

export const CONFIG_STORE_VERSION = DEFAULT_CONFIG_STORE_VERSION;

// Random address helper (uses ethers directly to avoid circular deps)
export function randomAddress(): string {
  return ethers.utils.getAddress(ethers.utils.hexlify(ethers.utils.randomBytes(20)));
}

export const randomL1Token = randomAddress();
export const randomOriginToken = randomAddress();
export const randomDestinationToken = randomAddress();
export const randomDestinationToken2 = randomAddress();

// Add Mainnet chain ID 1 to the chain ID list because the dataworker uses this chain to look up latest GlobalConfig
// updates for config variables like MAX_REFUND_COUNT_FOR_RELAYER_REPAYMENT_LEAF.
export const CHAIN_ID_TEST_LIST = [originChainId, destinationChainId, repaymentChainId, 1];
