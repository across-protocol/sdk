// import { Struct } from "superstruct";
// import { CachingMechanismInterface } from "../../interfaces";
import Arweave from "arweave";
import winston from "winston";
import { JWKInterface } from "arweave/node/lib/wallet";
import { assert } from "../../utils";

export class ArweaveClient {
  private client: Arweave;

  public constructor(
    private arweaveJWT: JWKInterface,
    private logger: winston.Logger,
    publicGatewayURL = "arweave.net"
  ) {
    this.client = new Arweave({
      host: publicGatewayURL,
      port: 443,
      protocol: "https",
      timeout: 20000,
      logging: false,
    });
    this.logger.info("Arweave client initialized");
  }

  //   get<ObjectType, OverrideType = unknown>(
  //     key?: string | undefined,
  //     structValidator?: Struct<unknown, unknown> | undefined,
  //     overrides?: OverrideType | undefined
  //   ): Promise<ObjectType | null> {
  //     throw new Error("Method not implemented.");
  //   }
  async set<ObjectType>(_key: string, value: ObjectType): Promise<string | undefined> {
    const transaction = await this.client.createTransaction({ data: JSON.stringify(value) }, this.arweaveJWT);
    // Add tags to the transaction
    transaction.addTag("Content-Type", "application/json");
    // Sign the transaction
    await this.client.transactions.sign(transaction, this.arweaveJWT);
    // Send the transaction
    const result = await this.client.transactions.post(transaction);
    // Ensure that the result is successful
    assert(result.status === 200, "Server failed to receive arweave transaction");
    return transaction.id;
  }

  getAddress(): Promise<string> {
    return this.client.wallets.jwkToAddress(this.arweaveJWT);
  }
  async getBalance(): Promise<string> {
    const address = await this.getAddress();
    return this.client.wallets.getBalance(address);
  }
}
