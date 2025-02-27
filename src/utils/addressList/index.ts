import { utils as ethersUtils } from "ethers";
import { AddressListAdapter, INVALID_ADDRESS } from "./types";
import * as bybit from "./adapters/bybit";

export class AddressList {
  constructor(readonly addressLists: AddressListAdapter[]) {}

  async update(): Promise<{ length: number; addresses: Set<string> }> {
    const _addresses = await Promise.all(this.addressLists.map((adapter) => adapter.update()));
    const addresses = _addresses
      .flat()
      .map((address) => {
        try {
          return ethersUtils.getAddress(address.toLowerCase());
        } catch {
          return INVALID_ADDRESS;
        }
      })
      .filter((address) => address !== INVALID_ADDRESS);
    return { addresses: new Set(addresses), length: addresses.length };
  }
}

async function run(): Promise<number> {
  const addressList = new AddressList([new bybit.AddressList()]);

  const { length, addresses } = await addressList.update();
  console.log(`Retrieved ${length} addresses: ${JSON.stringify(Array.from(addresses), null, 2)}`);

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
