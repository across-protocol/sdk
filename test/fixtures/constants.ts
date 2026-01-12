import { ethers } from "ethers";
import { toWei, toBN, utf8ToHex, randomAddress } from "../../src/utils";

// Token roles for ExpandedERC20
export const TokenRolesEnum = {
  OWNER: "0",
  MINTER: "1",
  BURNER: "3",
};

// Chain IDs - should match MockSpokePool.chainId() return value
export const destinationChainId = 1342;
export const originChainId = 666;
export const repaymentChainId = 777;

// Amounts
export const amountToSeedWallets = toWei("1500");
export const amountToLp = toWei("1000");
export const amountToDeposit = toWei("100");
export const amountToRelay = toWei("25");

// Fees
export const depositRelayerFeePct = toWei("0.1");
export const realizedLpFeePct = toWei("0.1");
export const oneHundredPct = toWei("1");

// Bond and liveness
export const bondAmount = toWei("5");
export const finalFee = toWei("1");
export const finalFeeUsdc = ethers.utils.parseUnits("1", 6);
export const finalFeeUsdt = ethers.utils.parseUnits("1", 6);
export const totalBond = toBN(bondAmount).add(toBN(finalFee));
export const refundProposalLiveness = 7200;

// Identifiers
export const identifier = utf8ToHex("ACROSS-V2");
export const zeroAddress = "0x0000000000000000000000000000000000000000";
export const zeroBytes32 = "0x0000000000000000000000000000000000000000000000000000000000000000";
export const zeroRawValue = { rawValue: "0" };

// Mock roots
export const mockTreeRoot = "0x" + "00".repeat(32);

// Helper to create random addresses for L2 tokens
export { randomAddress };
