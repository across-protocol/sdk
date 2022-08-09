import { providers } from "ethers";
import { SymbolMapping } from "./ethereum";
import { OptimismSpokePool__factory } from "@across-protocol/contracts-v2";

import { asL2Provider } from "@eth-optimism/sdk";
import { BaseQuery } from "./baseQuery";

export class OptimismQueries extends BaseQuery {
  constructor(
    provider: providers.Provider,
    symbolMapping = SymbolMapping,
    spokePoolAddress = "0xa420b2d1c0841415A695b81E5B867BCD07Dff8C9",
    usdcAddress = "0x7F5c764cBc14f9669B88837ca1490cCa17c31607",
    simulatedRelayerAddress = "0x893d0d70ad97717052e3aa8903d9615804167759",
    gasMultiplier = 0
  ) {
    super(
      asL2Provider(provider),
      symbolMapping,
      OptimismSpokePool__factory.connect(spokePoolAddress, asL2Provider(provider)),
      usdcAddress,
      simulatedRelayerAddress,
      gasMultiplier
    );
  }
}
