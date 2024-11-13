import { PublicClient } from "viem";
import { BaseHTTPAdapter, BaseHTTPAdapterArgs } from "../../priceClient/adapters/baseAdapter";
import { isDefined } from "../../utils";
import { CHAIN_IDs } from "../../constants";
import { InternalGasPriceEstimate } from "../types";
import { gasPriceError } from "../util";
import { eip1559 } from "./ethereum-viem";

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

const GWEI = BigInt(1_000_000_000);
class PolygonGasStation extends BaseHTTPAdapter {
  readonly chainId: number;

  constructor({ chainId = POLYGON, host, timeout = 1500, retries = 1 }: GasStationArgs = {}) {
    host = host ?? chainId === POLYGON ? "gasstation.polygon.technology" : "gasstation-testnet.polygon.technology";

    super("Polygon Gas Station", host, { timeout, retries });
    this.chainId = chainId;
  }

  async getFeeData(strategy: "safeLow" | "standard" | "fast" = "fast"): Promise<InternalGasPriceEstimate> {
    const gas = await this.query("v2", {});

    const gasPrice = (gas as GasStationV2Response)?.[strategy];
    if (!this.isPolygon1559GasPrice(gasPrice)) {
      // @todo: generalise gasPriceError() to accept a reason/cause?
      gasPriceError("getFeeData()", this.chainId, gasPrice);
    }

    const maxPriorityFeePerGas = BigInt(gasPrice.maxPriorityFee) * GWEI;
    const maxFeePerGas = BigInt(gasPrice.maxFee) * GWEI;

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

export async function gasStation(provider: PublicClient, chainId: number): Promise<InternalGasPriceEstimate> {
  const gasStation = new PolygonGasStation({ chainId, timeout: 2000, retries: 0 });
  let maxPriorityFeePerGas: bigint;
  let maxFeePerGas: bigint;
  try {
    ({ maxPriorityFeePerGas, maxFeePerGas } = await gasStation.getFeeData());
  } catch (err) {
    // Fall back to the RPC provider. May be less accurate.
    ({ maxPriorityFeePerGas, maxFeePerGas } = await eip1559(provider, chainId));

    // Per the GasStation docs, the minimum priority fee on Polygon is 30 Gwei.
    // https://docs.polygon.technology/tools/gas/polygon-gas-station/#interpretation
    const minPriorityFee = BigInt(30) * GWEI;
    if (minPriorityFee > maxPriorityFeePerGas) {
      const priorityDelta = minPriorityFee - maxPriorityFeePerGas;
      maxPriorityFeePerGas = minPriorityFee;
      maxFeePerGas = maxFeePerGas + priorityDelta;
    }
  }

  return { maxPriorityFeePerGas, maxFeePerGas };
}
