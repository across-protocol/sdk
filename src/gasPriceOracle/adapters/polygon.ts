import { providers, utils as ethersUtils } from "ethers";
import { BaseHTTPAdapter, BaseHTTPAdapterArgs } from "../../priceClient/adapters/baseAdapter";
import { isDefined } from "../../utils/TypeGuards";
import { GasPriceEstimate } from "../types";
import { gasPriceError } from "../util";
import { eip1559 } from "./ethereum";

type Polygon1559GasPrice = {
  maxPriorityFee: number | string;
  maxFee: number | string;
};

type GasStationV2Response = {
  safeLow: Polygon1559GasPrice;
  standard: Polygon1559GasPrice;
  fast: Polygon1559GasPrice;
  estimatedBaseFee: number | string;
  blockTime: number | string;
  blockNumber: number | string;
};

type GasStationArgs = BaseHTTPAdapterArgs & {
  chainId?: number;
  host?: string;
};

// @dev toBNWei() is not imported from ../utils because of a circular dependency loop.
//      The fix is probably to relocate the function estimateTotalGasRequiredByUnsignedTransaction().
class PolygonGasStation extends BaseHTTPAdapter {
  readonly chainId: number;

  constructor({ chainId = 137, host, timeout = 1500, retries = 1 }: GasStationArgs = {}) {
    host = host ?? chainId === 137 ? "gasstation.polygon.technology" : "gasstation-testnet.polygon.technology";

    super("Polygon Gas Station", host, { timeout, retries });
    this.chainId = chainId;
  }

  async getFeeData(strategy: "safeLow" | "standard" | "fast" = "fast"): Promise<GasPriceEstimate> {
    const gas = await this.query("v2", {});

    const gasPrice: Polygon1559GasPrice = (gas as GasStationV2Response)?.[strategy];
    if (!this.isPolygon1559GasPrice(gasPrice)) {
      // @todo: generalise gasPriceError() to accept a reason/cause?
      gasPriceError("getFeeData()", this.chainId, ethersUtils.parseUnits("0"));
    }

    [gasPrice.maxFee, gasPrice.maxPriorityFee].forEach((gasPrice) => {
      if (Number(gasPrice) < 0) {
        gasPriceError("getFeeData()", this.chainId, ethersUtils.parseUnits(gasPrice.toString(), 9));
      }
    });

    const maxPriorityFeePerGas = ethersUtils.parseUnits(gasPrice.maxPriorityFee.toString(), 9);
    const maxFeePerGas = ethersUtils.parseUnits(gasPrice.maxFee.toString(), 9);

    return { maxPriorityFeePerGas, maxFeePerGas };
  }

  protected isPolygon1559GasPrice(gasPrice: unknown): gasPrice is Polygon1559GasPrice {
    if (!isDefined(gasPrice)) {
      return false;
    }
    const _gasPrice = gasPrice as Polygon1559GasPrice;
    return [_gasPrice.maxPriorityFee, _gasPrice.maxFee].every((field) => ["number", "string"].includes(typeof field));
  }
}

export async function polygonGasStation(provider: providers.Provider, chainId: number): Promise<GasPriceEstimate> {
  const gasStation = new PolygonGasStation({ chainId: chainId });
  try {
    return await gasStation.getFeeData();
  } catch (err) {
    // Fall back to the RPC provider. May be less accurate.
    return await eip1559(provider, chainId);
  }
}
