import { Provider } from "@ethersproject/providers";
import { AcrossConfigStore, AcrossConfigStore__factory } from "@across-protocol/contracts-v2";
import { object, string, Infer, assert } from "superstruct";
import type { CallOverrides } from "@ethersproject/contracts";

const RateModel = object({
  UBar: string(), // denote the utilization kink along the rate model where the slope of the interest rate model changes.
  R0: string(), // is the interest rate charged at 0 utilization
  R1: string(), // R_0+R_1 is the interest rate charged at UBar
  R2: string(), // R_0+R_1+R_2 is the interest rate charged at 100% utilization
});
const L1TokenConfig = object({
  rateModel: RateModel,
  transferThreshold: string(),
});
export type RateModel = Infer<typeof RateModel>;
export type L1TokenConfig = Infer<typeof L1TokenConfig>;

export class Client {
  public readonly contract: AcrossConfigStore;
  constructor(address: string, provider: Provider) {
    this.contract = AcrossConfigStore__factory.connect(address, provider);
  }
  static parseL1TokenConfig(data: string): L1TokenConfig {
    const l1TokenConfig = JSON.parse(data);
    assert(l1TokenConfig, L1TokenConfig);
    return l1TokenConfig;
  }
  async getL1TokenConfig(l1TokenAddress: string, overrides: CallOverrides = {}): Promise<L1TokenConfig> {
    const data = await this.contract.l1TokenConfig(l1TokenAddress, overrides);
    return Client.parseL1TokenConfig(data);
  }
  async getRateModel(l1TokenAddress: string, overrides: CallOverrides = {}): Promise<RateModel> {
    const l1TokenConfig = await this.getL1TokenConfig(l1TokenAddress, overrides);
    return l1TokenConfig.rateModel;
  }
}
