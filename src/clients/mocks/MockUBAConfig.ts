import { parseEther } from "ethers/lib/utils";
import UBAConfig from "../../UBAFeeCalculator/UBAFeeConfig";
import { toBN } from "../../utils";
import { FlowTupleParameters } from "../UBAClient";
import { BigNumber } from "ethers";

export class MockUBAConfig extends UBAConfig {
  constructor() {
    super(
      {
        default: toBN(0),
      },
      {
        default: [[toBN(100000), toBN(0)]],
      },
      {
        default: {
          upperBound: {},
          lowerBound: {},
        },
      },
      {
        default: [[toBN(0), parseEther("1")]],
      },
      {},
      {}
    );
    this.balancingFee.default = [
      // Hardcode the config to be 200% as a fee for all flows
      [toBN(0), parseEther("2")],
      [toBN(100000), toBN(0)],
    ];
  }

  public setBalancingFeeCurve(chainId: string, curve: FlowTupleParameters) {
    this.balancingFee.override = {
      ...(this.balancingFee.override || {}),
      [chainId]: curve,
    };
  }

  public setBalancingFeeDefaultCurve(curve: FlowTupleParameters) {
    this.balancingFee.default = curve;
  }

  public setRewardMultiplier(chainId: string, multiplier: BigNumber) {
    this.ubaRewardMultiplier[chainId] = multiplier;
  }
}
