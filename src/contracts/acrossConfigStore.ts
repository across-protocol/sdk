import { Provider } from "@ethersproject/providers";
import { AcrossConfigStore, AcrossConfigStore__factory } from "../typechain";
import { object, string, Infer, assert, mask, record, optional } from "superstruct";
import type { CallOverrides } from "@ethersproject/contracts";
import { filterFalsyKeys } from "../utils";

const RateModelSs = object({
  UBar: string(), // denote the utilization kink along the rate model where the slope of the interest rate model changes.
  R0: string(), // is the interest rate charged at 0 utilization
  R1: string(), // R_0+R_1 is the interest rate charged at UBar
  R2: string(), // R_0+R_1+R_2 is the interest rate charged at 100% utilization
});
const L1TokenConfigSs = object({
  rateModel: RateModelSs,
  routeRateModel: optional(record(string(), RateModelSs)),
});
export type RateModel = Infer<typeof RateModelSs>;
export type L1TokenConfig = Infer<typeof L1TokenConfigSs>;

export class Client {
  public readonly contract: AcrossConfigStore;
  constructor(address: string, provider: Provider) {
    this.contract = AcrossConfigStore__factory.connect(address, provider);
  }
  static parseL1TokenConfig(data: string): L1TokenConfig {
    const l1TokenConfig = JSON.parse(data);
    const l1TokenConfigMask = filterFalsyKeys(mask(l1TokenConfig, L1TokenConfigSs));
    assert(l1TokenConfigMask, L1TokenConfigSs);
    return l1TokenConfigMask;
  }
  async getL1TokenConfig(l1TokenAddress: string, overrides: CallOverrides = {}): Promise<L1TokenConfig> {
    const data = await this.contract.l1TokenConfig(l1TokenAddress, overrides);
    return Client.parseL1TokenConfig(data);
  }
  async getRateModel(
    l1TokenAddress: string,
    overrides: CallOverrides = {},
    originChainId?: number,
    destinationChainId?: number
  ): Promise<RateModel> {
    const l1TokenConfig = await this.getL1TokenConfig(l1TokenAddress, overrides);
    if (originChainId === undefined || destinationChainId === undefined) return l1TokenConfig.rateModel;
    const routeRateModelKey = `${originChainId}-${destinationChainId}`;
    if (l1TokenConfig.routeRateModel && l1TokenConfig.routeRateModel[routeRateModelKey]) {
      return l1TokenConfig.routeRateModel[routeRateModelKey];
    }
    return l1TokenConfig.rateModel;
  }
}
