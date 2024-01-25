import { random } from "lodash";
import { getCurrentTime, toBNWei } from "../src/utils";
import {
  DepositWithBlock,
  FillWithBlock,
  UbaFlow,
  UbaOutflow,
  isUbaInflow,
  isUbaOutflow,
  outflowIsFill,
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

describe("UBA Interface", function () {
  it("Predicates", function () {
    const deposit: DepositWithBlock = { ...common, ...sampleDeposit };
    const fill: FillWithBlock = { ...common, ...sampleFill };

    // FundsDeposited event. All UbaInflows are Deposits.
    expect(isUbaInflow(deposit as UbaFlow)).to.be.true;
    expect(isUbaOutflow(deposit as UbaFlow)).to.be.false;

    // FilledRelay event
    for (const slowRelay of [true, false]) {
      fill.updatableRelayData.isSlowRelay = slowRelay;
      expect(isUbaInflow(fill as UbaFlow)).to.be.false;
      expect(isUbaOutflow(fill as UbaFlow)).to.be.true;
      expect(outflowIsFill(fill as UbaOutflow)).to.be.true;
    }
  });
});
