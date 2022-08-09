import { utils, providers } from "ethers";
import { SymbolMapping } from "./ethereum";
import { OptimismSpokePool__factory } from "@across-protocol/contracts-v2";
import { BaseQuery } from "./baseQuery";

const { parseUnits } = utils;

export class BobaQueries extends BaseQuery {
  constructor(
    provider: providers.Provider,
    symbolMapping = SymbolMapping,
    spokePoolAddress = "0xBbc6009fEfFc27ce705322832Cb2068F8C1e0A58",
    usdcAddress = "0x66a2A913e447d6b4BF33EFbec43aAeF87890FBbc",
    simulatedRelayerAddress = "0x893d0d70ad97717052e3aa8903d9615804167759",
    gasMultiplier = 0
  ) {
    super(
      provider,
      symbolMapping,
      OptimismSpokePool__factory.connect(spokePoolAddress, provider),
      usdcAddress,
      simulatedRelayerAddress,
      gasMultiplier,
      parseUnits("1", 9)
    );
  }
}
