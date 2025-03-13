import { utils as ethersUtils } from "ethers";
import { Logger, mapAsync } from "../utils";
import { AddressListAdapter, INVALID_ADDRESS } from "./types";
import * as adapters from "./adapters";

export * as adapters from "./adapters";

export class AddressAggregator {
  constructor(
    readonly adapters: AddressListAdapter[],
    protected readonly logger?: Logger
  ) {}

  static sources(): string[] {
    return Object.keys(adapters);
  }

  async update(): Promise<Set<string>> {
    this.logger?.debug({
      at: "AddressAggregator::update",
      message: "Updating addresses.",
      sources: this.adapters.map((adapter) => adapter.name),
      supportedSources: AddressAggregator.sources(),
    });

    const allAddresses = await mapAsync(this.adapters, async (adapter) => {
      const invalidAddresses: string[] = [];
      const addresses = (await adapter.update(this.logger))
        .map((address) => {
          try {
            return ethersUtils.getAddress(address.toLowerCase());
          } catch {
            invalidAddresses.push(address);
            return INVALID_ADDRESS;
          }
        })
        .filter((address) => address !== INVALID_ADDRESS);

      if (invalidAddresses.length > 0) {
        this.logger?.warn({
          at: "AddressAggregator::update()",
          message: `Read ${invalidAddresses.length} malformed addresses on ${adapter.name}.`,
          invalidAddresses,
        });
      }

      this.logger?.debug({
        at: "AddressAggregator::update",
        message: `Loaded ${addresses.length} addresses from ${adapter.name}.`,
      });

      return addresses;
    });

    // Dedup the aggregated, normalised, filtered set of addresses.
    const addresses = new Set(allAddresses.flat());

    this.logger?.debug({
      at: "AddressAggregator::update",
      message: `Loaded ${addresses.size} addresses.`,
      sources: this.adapters.map((adapter) => adapter.name),
    });

    return addresses;
  }
}

async function run(): Promise<number> {
  const addressList = new AddressAggregator([new adapters.bybit.AddressList(), new adapters.processEnv.AddressList()]);

  const addresses = await addressList.update();
  console.log(`Retrieved ${addresses.size} addresses: ${JSON.stringify(Array.from(addresses), null, 2)}`);

  return 0;
}

if (require.main === module) {
  run()
    .then((result: number) => {
      process.exitCode = result;
    })
    .catch((error) => {
      console.error("Process exited with", error);
      process.exitCode = 127;
    });
}
