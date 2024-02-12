import { BigNumber } from "ethers";
import { object, number, coerce, string, define } from "superstruct";
import { FillStatus } from "../../interfaces";

export type FillsRefundedLeaf = {
  // If fill was sent in this bundle, then no slow fill was
  // created in this bundle.
  status: FillStatus;
  relayDataHash: string;
  lpFeePct: BigNumber;
  relayer: string;
  repaymentChainId: number;
  paymentAmount: BigNumber;
  paymentRecipient: string;
  paymentMessage: string;
};

const BigNumberType = define<BigNumber>("BigNumber", BigNumber.isBigNumber);
const FillStatusType = define<FillStatus>("FillStatus", (value): value is FillStatus =>
  Object.values(FillStatus).includes(Number(value))
);

// Coercion function for converting a string to a BigNumber
const BigNumberFromString = coerce(BigNumberType, string(), (value) => BigNumber.from(value));

export const FillsRefundedLeafSS = object({
  status: FillStatusType,
  relayDataHash: string(),
  lpFeePct: BigNumberFromString,
  relayer: string(),
  repaymentChainId: number(),
  paymentAmount: BigNumberFromString,
  paymentRecipient: string(),
  paymentMessage: string(),
});
