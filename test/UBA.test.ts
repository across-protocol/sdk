import { random } from "lodash";
import { getCurrentTime, toBN, toBNWei } from "../src/utils";
import {
  DepositWithBlock,
  FillWithBlock,
  RefundRequestWithBlock,
  UbaFlow,
  UbaOutflow,
  isUbaInflow,
  isUbaOutflow,
  outflowIsFill,
  outflowIsRefund,
} from "../src/interfaces";
import { expect } from "./utils";

const now = getCurrentTime();

const common = {
  depositId: random(1, 1000, false),
  amount: toBNWei(0.01),
  originChainId: 1,
  destinationChainId: 10,
  blockNumber: 1,
  blockTimestamp: now,
  transactionIndex: 0,
  logIndex: 0,
  transactionHash: "",
};

const sampleDeposit = {
  depositor: "",
  recipient: "",
  originToken: "",
  relayerFeePct: toBNWei(0.0001),
  quoteTimestamp: now,
  realizedLpFeePct: toBNWei(0.00001),
  destinationToken: "",
  quoteBlockNumber: 1,
  message: "0x",
};

const sampleFill = {
  totalFilledAmount: toBNWei(0.01),
  fillAmount: toBNWei(0.01),
  destinationChainId: 10,
  repaymentChainId: 10,
  relayerFeePct: toBNWei(0.0001),
  appliedRelayerFeePct: toBNWei(0.0001),
  realizedLpFeePct: toBNWei(0.00001),
  destinationToken: "",
  relayer: "",
  depositor: "",
  recipient: "",
  message: "0x",
  updatableRelayData: {
    isSlowRelay: true,
    recipient: "",
    message: "0x",
    payoutAdjustmentPct: toBNWei(0),
    relayerFeePct: toBNWei(0.0001),
  },
};

const sampleRefundRequest = {
  relayer: "",
  refundToken: "",
  realizedLpFeePct: toBNWei(0.0001),
  fillBlock: toBN(random(1, 1000, false)),
  previousIdenticalRequests: toBN(0),
  repaymentChainId: 137,
};

describe("UBA Interface", function () {
  it("Predicates", function () {
    const deposit: DepositWithBlock = { ...common, ...sampleDeposit };
    const fill: FillWithBlock = { ...common, ...sampleFill };
    const refundRequest: RefundRequestWithBlock = { ...common, ...sampleRefundRequest };

    // FundsDeposited event. All UbaInflows are Deposits.
    expect(isUbaInflow(deposit as UbaFlow)).to.be.true;
    expect(isUbaOutflow(deposit as UbaFlow)).to.be.false;

    // FilledRelay event
    for (const slowRelay of [true, false]) {
      fill.updatableRelayData.isSlowRelay = slowRelay;
      expect(isUbaInflow(fill as UbaFlow)).to.be.false;
      expect(isUbaOutflow(fill as UbaFlow)).to.be.true;
      expect(outflowIsFill(fill as UbaOutflow)).to.be.true;
      expect(outflowIsRefund(fill as UbaOutflow)).to.be.false;
    }

    // RefundRequested event
    expect(isUbaInflow(refundRequest as UbaFlow)).to.be.false;
    expect(isUbaOutflow(refundRequest as UbaFlow)).to.be.true;
    expect(outflowIsFill(refundRequest as UbaOutflow)).to.be.false;
    expect(outflowIsRefund(refundRequest as UbaOutflow)).to.be.true;
  });
});
