import { QueryInterface } from "../relayFeeCalculator";
import { BigNumberish } from "../../utils";
import ethers from "ethers";
import { SymbolMapping } from "./ethereum";
import { Coingecko } from "../../coingecko/Coingecko";
import { OptimismSpokePool__factory, OptimismSpokePool } from "@across-protocol/contracts-v2";

const { parseUnits } = ethers.utils;

export class BobaQueryInterface implements QueryInterface {
  private spokePool: OptimismSpokePool;

  constructor(
    provider: ethers.providers.Provider,
    spokePoolAddress = "0x59485d57EEcc4058F7831f46eE83a7078276b4AE",
    private readonly usdcAddress = "0x66a2A913e447d6b4BF33EFbec43aAeF87890FBbc",
    private readonly simulatedRelayerAddress = "0x9a8f92a830a5cb89a3816e3d267cb7791c16b04d"
  ) {
    // TODO: replace with address getter.
    this.spokePool = OptimismSpokePool__factory.connect(spokePoolAddress, provider);
  }

  async getGasCosts(tokenSymbol: string): Promise<BigNumberish> {
    // Create a dummy transaction to estimate. Note: the simulated caller would need to be holding weth and have approved the contract.
    const gasEstimate = await this.spokePool.estimateGas.fillRelay(
      "0xBb23Cd0210F878Ea4CcA50e9dC307fb0Ed65Cf6B",
      "0xBb23Cd0210F878Ea4CcA50e9dC307fb0Ed65Cf6B",
      this.usdcAddress,
      "10",
      "10",
      "1",
      "1",
      "1",
      "1",
      "1",
      { from: this.simulatedRelayerAddress }
    );

    // Boba's gas price is hardcoded to 1 gwei.
    const bobaGasPrice = parseUnits("1", 9);
    return gasEstimate.mul(bobaGasPrice).toString();
  }

  async getTokenPrice(tokenSymbol: string): Promise<string | number> {
    const [, price] = await Coingecko.get().getCurrentPriceByContract(SymbolMapping[tokenSymbol].address, "eth");
    return price;
  }

  async getTokenDecimals(tokenSymbol: string): Promise<number> {
    return SymbolMapping[tokenSymbol].decimals;
  }
}
