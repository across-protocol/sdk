import { utils as ethersUtils } from "ethers";
import { AddressListAdapter, INVALID_ADDRESS } from "./types";
import * as bybit from "./adapters/bybit";

export class AddressList {
  constructor(readonly addressLists: AddressListAdapter[]) {}

  async update(): Promise<Set<string>> {
    const rawAddresses = await Promise.all(this.addressLists.map((adapter) => adapter.update()));
    const allAddresses = rawAddresses
      .flat()
      .map((address) => {
        try {
          return ethersUtils.getAddress(address.toLowerCase());
        } catch {
          return INVALID_ADDRESS;
        }
      })
      .filter((address) => address !== INVALID_ADDRESS);

    // Dedup the aggregated, normalised, filtered set of addresses.
    return new Set(allAddresses);
  }
}

async function run(): Promise<number> {
  const addressList = new AddressList([new bybit.AddressList()]);

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
