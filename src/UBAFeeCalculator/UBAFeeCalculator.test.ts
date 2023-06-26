import { expect } from "chai";
import { toBN } from "../utils";
import UBAFeeConfig from "./UBAFeeConfig";
import {
  computePiecewiseLinearFunction,
  getBounds,
  getDepositBalancingFee,
  getInterval,
  getRefundBalancingFee,
  performLinearIntegration,
} from "./UBAFeeUtility";
import { FlowTupleParameters } from "./UBAFeeConfig";
import { MAX_SAFE_JS_INT } from "@uma/common";
import { parseEther, parseUnits } from "ethers/lib/utils";
import { BigNumber } from "ethers";

describe("UBA Fee Calculations", () => {
  let config: UBAFeeConfig;
  let tuples: FlowTupleParameters;

  beforeEach(() => {
    config = new UBAFeeConfig(
      {
        default: toBN("300000000000000"),
      },
      toBN(0),
      {
        default: [
          [toBN("100000"), parseUnits("-0.4", 18)],
          [toBN("250000"), parseUnits("-0.25", 18)],
          [toBN("500000"), parseUnits("-0.1", 18)],
          [toBN("750000"), parseUnits("-0.01", 18)],
          [toBN("1000000"), parseUnits("-0.005", 18)],
          [toBN("1500000"), parseUnits("-0.0005", 18)],
          [toBN("2000000"), parseUnits("0.0", 18)],
          [toBN("4000000"), parseUnits("0.0", 18)],
          [toBN("5500000"), parseUnits("0.0005", 18)],
          [toBN("6000000"), parseUnits("0.005", 18)],
          [toBN("6500000"), parseUnits("0.01", 18)],
          [toBN("7000000"), parseUnits("0.1", 18)],
          [toBN("8000000"), parseUnits("0.25", 18)],
          [toBN("9000000"), parseUnits("0.4", 18)],
        ],
      },
      {},
      { default: [] }
    );
    tuples = config.getBalancingFeeTuples(0);
  });

  it("should accurately return the correct lower/upper bounds from a given index", () => {
    const [lowerBound, upperBound] = getBounds(tuples, 3);
    expect(lowerBound.toString()).to.eq("500000");
    expect(upperBound.toString()).to.eq("750000");
  });

  it("should return an expected interval for a given value", () => {
    const [idx, [lowerBound, upperBound]] = getInterval(tuples, toBN("12000000"));
    expect(idx).to.eq(14);
    expect(lowerBound.toString()).to.eq("9000000");
    expect(upperBound.toString()).to.eq(BigNumber.from(MAX_SAFE_JS_INT).mul(parseEther("1")).toString().toString());
  });

  it("should integrate the correct value: test #1", () => {
    const result = performLinearIntegration(tuples, 0, toBN(0), toBN(100_000));
    expect(result.toString()).to.eq("-40000");
  });

  it("should integrate the correct value: test #2", () => {
    const result = performLinearIntegration(tuples, 0, toBN(100_000), toBN(0));
    expect(result.toString()).to.eq("40000");
  });

  it("should integrate the correct value: test #3", () => {
    const result = performLinearIntegration(tuples, 1, toBN(100_000), toBN(250_000));
    expect(result.toString()).to.eq("-48750");
  });

  it("should integrate the correct value: test #4", () => {
    const result = performLinearIntegration(tuples, 1, toBN(250_000), toBN(100_000));
    expect(result.toString()).to.eq("48750");
  });

  it("should compute the correct deposit fee #1", () => {
    const result = getDepositBalancingFee(tuples, toBN(300_000), toBN(50_000));
    expect(result.toString()).to.eq("-10250");
  });

  it("should compute the correct deposit fee #2", () => {
    const result = getDepositBalancingFee(tuples, toBN(300_000), toBN(100_000));
    expect(result.toString()).to.eq("-19000");
  });

  it("should compute the correct refund fee #1", () => {
    const result = getRefundBalancingFee(tuples, toBN(350_000), toBN(50_000));
    expect(result.toString()).to.eq("10250");
  });

  it("should compute the correct refund fee #2", () => {
    const result = getRefundBalancingFee(tuples, toBN(300_000), toBN(100_000));
    expect(result.toString()).to.eq("25500");
  });
});

describe("UBA Fee Calculations from Data", () => {
  let gammaCutoffArray: FlowTupleParameters;
  let omegaCutoffArray: FlowTupleParameters;

  beforeEach(() => {
    gammaCutoffArray = [
      [toBN("500000000000000000"), toBN("0")],
      [toBN("750000000000000000"), toBN("100000000000000")],
      [toBN("950000000000000000"), toBN("10000000000000000")],
    ];

    omegaCutoffArray = [
      [toBN("0"), toBN("-100000000000000")],
      [toBN("250000000000000000000"), toBN("0")],
      [toBN("500000000000000000000"), toBN("0")],
      [toBN("750000000000000000000"), toBN("100000000000000")],
      [toBN("1500000000000000000000"), toBN("10000000000000000")],
    ];

    omegaCutoffArray;
  });

  it("should integrate the correct value: test #1", () => {
    const result = computePiecewiseLinearFunction(
      gammaCutoffArray,
      toBN("600000000000000000"),
      toBN("625000000000000000")
    );
    expect(result.toString()).to.eq("1125000000000");
  });

  it("should integrate the correct value: test #2", () => {
    const result = computePiecewiseLinearFunction(
      gammaCutoffArray,
      toBN("500000000000000000"),
      toBN("625000000000000000")
    );
    expect(result.toString()).to.eq("3125000000000");
  });

  it("should integrate the correct value: test #3", () => {
    const result = computePiecewiseLinearFunction(gammaCutoffArray, toBN("0"), toBN("400000000000000000"));
    expect(result.toString()).to.eq("0");
  });

  it("should integrate the correct value: test #4", () => {
    const result = computePiecewiseLinearFunction(gammaCutoffArray, toBN("0"), toBN("1000000000000000000"));
    expect(result.toString()).to.eq("1522500000000000");
  });

  it("should retrieve the proper bounds. Test #1", () => {
    const [lowerBound, upperBound] = getBounds(gammaCutoffArray, 0);
    expect(lowerBound.toString()).to.eq(BigNumber.from(-MAX_SAFE_JS_INT).mul(parseEther("1")).toString());
    expect(upperBound.toString()).to.eq("500000000000000000");
  });

  it("should retrieve the proper bounds. Test #2", () => {
    const [lowerBound, upperBound] = getBounds(gammaCutoffArray, 1);

    expect(lowerBound.toString()).to.eq("500000000000000000");
    expect(upperBound.toString()).to.eq("750000000000000000");
  });

  it("should retrieve the proper bounds. Test #3", () => {
    const [lowerBound, upperBound] = getBounds(omegaCutoffArray, 4);

    expect(lowerBound.toString()).to.eq("750000000000000000000");
    expect(upperBound.toString()).to.eq("1500000000000000000000");
  });
});
