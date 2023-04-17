import { random } from "lodash";
import { toBN, toBNWei } from "../utils";
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
} from "./";

const common = {
  depositId: random(1, 1000, false),
  amount: toBNWei(0.01),
  originChainId: 1,
  destinationChainId: 10,
  blockNumber: 1,
  transactionIndex: 0,
  logIndex: 0,
  transactionHash: "",
};

const sampleDeposit = {
  depositor: "",
  recipient: "",
  originToken: "",
  relayerFeePct: toBNWei(0.0001),
  quoteTimestamp: Math.floor(Date.now() / 1000),
  realizedLpFeePct: toBNWei(0.00001),
  destinationToken: "",
  originBlockNumber: 1,
};

const sampleFill = {
  totalFilledAmount: toBNWei(0.01),
  fillAmount: toBNWei(0.01),
  repaymentChainId: 10,
  relayerFeePct: toBNWei(0.0001),
  appliedRelayerFeePct: toBNWei(0.0001),
  realizedLpFeePct: toBNWei(0.00001),
  destinationToken: "",
  relayer: "",
  depositor: "",
  recipient: "",
  isSlowRelay: true,
  destinationChainId: 10,
};

const sampleRefundRequest = {
  relayer: "",
  refundToken: "",
  realizedLpFeePct: toBNWei(0.0001),
  fillBlock: toBN(random(1, 1000, false)),
  previousIdenticalRequests: toBN(0),
};

describe("UBA Interface", function () {
  test("Predicates", function () {
    const deposit: DepositWithBlock = { ...common, ...sampleDeposit };
    const fill: FillWithBlock = { ...common, ...sampleFill };
    const refundRequest: RefundRequestWithBlock = { ...common, ...sampleRefundRequest };

    // FundsDeposited event. All UbaInflows are Deposits.
    expect(isUbaInflow(deposit as UbaFlow)).toBe(true);
    expect(isUbaOutflow(deposit as UbaFlow)).toBe(false);

    // FilledRelay event
    for (const slowRelay of [true, false]) {
      fill.isSlowRelay = slowRelay;
      expect(isUbaInflow(fill as UbaFlow)).toBe(false);
      expect(isUbaOutflow(fill as UbaFlow)).toBe(true);
      expect(outflowIsFill(fill as UbaOutflow)).toBe(true);
      expect(outflowIsRefund(fill as UbaOutflow)).toBe(false);
    }

    // RefundRequested event
    expect(isUbaInflow(refundRequest as UbaFlow)).toBe(false);
    expect(isUbaOutflow(refundRequest as UbaFlow)).toBe(true);
    expect(outflowIsFill(refundRequest as UbaOutflow)).toBe(false);
    expect(outflowIsRefund(refundRequest as UbaOutflow)).toBe(true);
  });
});
