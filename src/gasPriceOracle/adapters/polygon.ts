import { providers } from "ethers";
import { BaseHTTPAdapter, BaseHTTPAdapterArgs } from "../../priceClient/adapters/baseAdapter";
import { BigNumber, bnZero, isDefined, parseUnits } from "../../utils";
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

export class MockPolygonGasStation extends PolygonGasStation {
  constructor(
    readonly baseFee: BigNumber,
    readonly priorityFee: BigNumber,
    readonly getFeeDataThrows = false
  ) {
    super();
  }

  getFeeData(): Promise<GasPriceEstimate> {
    if (this.getFeeDataThrows) throw new Error();
    return Promise.resolve({
      maxPriorityFeePerGas: this.priorityFee,
      maxFeePerGas: this.baseFee.add(this.priorityFee),
    });
  }
}

export async function gasStation(
  provider: providers.Provider,
  opts: GasPriceEstimateOptions
): Promise<GasPriceEstimate> {
  const { chainId, baseFeeMultiplier, polygonGasStation } = opts;
  const gasStation = polygonGasStation ?? new PolygonGasStation({ chainId: chainId, timeout: 2000, retries: 0 });
  let maxPriorityFeePerGas: BigNumber;
  let maxFeePerGas: BigNumber;
  try {
    ({ maxPriorityFeePerGas, maxFeePerGas } = await gasStation.getFeeData());
    const baseFeeMinusPriorityFee = maxFeePerGas.sub(maxPriorityFeePerGas);
    const scaledBaseFee = baseFeeMinusPriorityFee.mul(baseFeeMultiplier);
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
