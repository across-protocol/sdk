import { providers } from "ethers";
import { BaseHTTPAdapter, BaseHTTPAdapterArgs } from "../../priceClient/adapters/baseAdapter";
import { BigNumber, bnZero, fixedPointAdjustment, isDefined, parseUnits } from "../../utils";
import { CHAIN_IDs } from "../../constants";
import { GasPriceEstimate } from "../types";
import { gasPriceError } from "../util";
import { eip1559 } from "./ethereum";
import { GasPriceEstimateOptions } from "../oracle";

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

const { POLYGON } = CHAIN_IDs;

export class PolygonGasStation extends BaseHTTPAdapter {
  readonly chainId: number;

  constructor({ chainId = POLYGON, host, timeout = 1500, retries = 1 }: GasStationArgs = {}) {
    host = host ?? chainId === POLYGON ? "gasstation.polygon.technology" : "gasstation-testnet.polygon.technology";

    super("Polygon Gas Station", host, { timeout, retries });
    this.chainId = chainId;
  }

  async getFeeData(strategy: "safeLow" | "standard" | "fast" = "fast"): Promise<GasPriceEstimate> {
    const gas = await this.query("v2", {});

    const gasPrice = (gas as GasStationV2Response)?.[strategy];
    if (!this.isPolygon1559GasPrice(gasPrice)) {
      // @todo: generalise gasPriceError() to accept a reason/cause?
      gasPriceError("getFeeData()", this.chainId, bnZero);
    }

    [gasPrice.maxFee, gasPrice.maxPriorityFee].forEach((gasPrice) => {
      if (Number(gasPrice) < 0) {
        gasPriceError("getFeeData()", this.chainId, parseUnits(gasPrice.toString(), 9));
      }
    });

    const maxPriorityFeePerGas = parseUnits(gasPrice.maxPriorityFee.toString(), 9);
    const maxFeePerGas = parseUnits(gasPrice.maxFee.toString(), 9);

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

class MockRevertingPolygonGasStation extends PolygonGasStation {
  getFeeData(): Promise<GasPriceEstimate> {
    throw new Error();
  }
}

export const MockPolygonGasStationBaseFee = () => parseUnits("12", 9);
export const MockPolygonGasStationPriorityFee = () => parseUnits("1", 9);

class MockPolygonGasStation extends PolygonGasStation {
  getFeeData(): Promise<GasPriceEstimate> {
    return Promise.resolve({
      maxPriorityFeePerGas: MockPolygonGasStationPriorityFee(),
      maxFeePerGas: MockPolygonGasStationBaseFee().add(MockPolygonGasStationPriorityFee()),
    });
  }
}

/**
 * @notice Returns the gas price suggested by the Polygon GasStation API or reconstructs it using
 * the eip1559() method as a fallback.
 * @param provider Ethers Provider.
 * @returns GasPriceEstimate
 */
export async function gasStation(
  provider: providers.Provider,
  opts: GasPriceEstimateOptions
): Promise<GasPriceEstimate> {
  const { chainId, baseFeeMultiplier } = opts;
  let gasStation: PolygonGasStation;
  if (process.env.TEST_POLYGON_GAS_STATION === "true") {
    gasStation = new MockPolygonGasStation();
  } else if (process.env.TEST_REVERTING_POLYGON_GAS_STATION === "true") {
    gasStation = new MockRevertingPolygonGasStation();
  } else {
    gasStation = new PolygonGasStation({ chainId: chainId, timeout: 2000, retries: 0 });
  }
  let maxPriorityFeePerGas: BigNumber;
  let maxFeePerGas: BigNumber;
  try {
    ({ maxPriorityFeePerGas, maxFeePerGas } = await gasStation.getFeeData());
    // Assume that the maxFeePerGas already includes the priority fee, so back out the priority fee before applying
    // the baseFeeMultiplier.
    const baseFeeMinusPriorityFee = maxFeePerGas.sub(maxPriorityFeePerGas);
    const scaledBaseFee = baseFeeMinusPriorityFee.mul(baseFeeMultiplier).div(fixedPointAdjustment);
    maxFeePerGas = scaledBaseFee.add(maxPriorityFeePerGas);
  } catch (err) {
    // Fall back to the RPC provider. May be less accurate.
    ({ maxPriorityFeePerGas, maxFeePerGas } = await eip1559(provider, opts));

    // Per the GasStation docs, the minimum priority fee on Polygon is 30 Gwei.
    // https://docs.polygon.technology/tools/gas/polygon-gas-station/#interpretation
    const minPriorityFee = parseUnits("30", 9);
    if (maxPriorityFeePerGas.lt(minPriorityFee)) {
      const priorityDelta = minPriorityFee.sub(maxPriorityFeePerGas);
      maxPriorityFeePerGas = minPriorityFee;
      maxFeePerGas = maxFeePerGas.add(priorityDelta);
    }
  }

  return { maxPriorityFeePerGas, maxFeePerGas };
}
